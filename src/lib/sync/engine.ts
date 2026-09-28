/**
 * Session orchestration: signaling (manual codes or a relay), key agreement,
 * the SAS step, and handing the open channel to the protocol runner.
 */
import type { LeafletStore, PeerRecord } from "@/lib/db/types";
import {
  decodeSignalCode,
  encodeSignalCode,
  type SignalPayload,
} from "./codes";
import {
  deriveSharedKeys,
  openEnvelope,
  roomId,
  type SharedKeys,
  sealEnvelope,
  shortAuthString,
} from "./crypto";
import { SyncError, syncErrorMessage } from "./errors";
import {
  ensureDeviceIdentity,
  normalizeDeviceName,
  publicKeyCoordinates,
  publicKeyFromCoordinates,
} from "./identity";
import {
  type ImportEpubFn,
  type ProtocolRun,
  runSyncProtocol,
} from "./protocol";
import { connectRelay, type RelayConnection } from "./relay-signaling";
import type {
  ManualSessionOptions,
  PairedDevice,
  RelaySessionOptions,
  SyncDevice,
  SyncEngine,
  SyncEvent,
  SyncSession,
} from "./types";
import {
  channelFromDataChannel,
  createAnswerSdp,
  createOfferSdp,
  createPeerConnection,
  DEFAULT_ICE_SERVERS,
  dtlsFingerprint,
  SYNC_CHANNEL_LABEL,
  waitForChannelOpen,
  waitForDataChannel,
} from "./webrtc";

export interface SyncEngineOptions {
  iceServers?: RTCIceServer[];
  importEpub?: ImportEpubFn;
  /** How long a relay session waits for the paired device to show up. */
  relayWaitMs?: number;
}

/** Plaintext of a relay envelope; the fingerprint binds it to the SDP it carries. */
interface RelaySignal {
  deviceId: string;
  fingerprint: string;
  role: "offer" | "answer";
  sdp: string;
}

const ANSWER_WAIT_MS = 10 * 60 * 1000;
const RELAY_WAIT_MS = 2 * 60 * 1000;
const CLOSE_GRACE_MS = 500;

interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: SyncError) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: SyncError) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(ignore);
  return { promise, resolve, reject };
}

const ignore = (): undefined => undefined;

async function defaultImportEpub(
  ...args: Parameters<ImportEpubFn>
): ReturnType<ImportEpubFn> {
  const epub = await import("@/lib/epub");
  return epub.importEpub(...args);
}

class Session implements SyncSession {
  readonly id = crypto.randomUUID();
  private readonly listeners = new Set<(event: SyncEvent) => void>();
  private readonly backlog: SyncEvent[] = [];
  private readonly remoteCode = deferred<SignalPayload>();
  private readonly sas = deferred<void>();
  private cancelled = false;
  pc: RTCPeerConnection | null = null;
  relay: RelayConnection | null = null;
  run: ProtocolRun | null = null;

  readonly role: "offer" | "answer";
  private readonly expectsRemote: "answer" | null;

  constructor(role: "offer" | "answer", expectsRemote: "answer" | null) {
    this.role = role;
    this.expectsRemote = expectsRemote;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get remotePayload(): Promise<SignalPayload> {
    return this.remoteCode.promise;
  }

  get sasConfirmed(): Promise<void> {
    return this.sas.promise;
  }

  subscribe(listener: (event: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.backlog.length) {
      for (const event of this.backlog.splice(0)) {
        listener(event);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: SyncEvent): void {
    if (this.listeners.size === 0) {
      this.backlog.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  acceptRemoteCode(code: string): Promise<void> {
    if (!this.expectsRemote) {
      return Promise.reject(
        new SyncError(
          "not_applicable",
          "This session already has the other device's code."
        )
      );
    }
    try {
      this.remoteCode.resolve(decodeSignalCode(code, this.expectsRemote));
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  confirmSas(): void {
    this.sas.resolve();
  }

  cancel(): void {
    if (this.cancelled) {
      return;
    }
    this.cancelled = true;
    const reason = new SyncError("cancelled", "Sync was cancelled.");
    this.remoteCode.reject(reason);
    this.sas.reject(reason);
    this.run?.abort(reason);
    this.teardown();
  }

  teardown(): void {
    this.relay?.close();
    this.relay = null;
    const pc = this.pc;
    this.pc = null;
    if (pc) {
      setTimeout(() => pc.close(), CLOSE_GRACE_MS);
    }
  }
}

export function createSyncEngine(
  store: LeafletStore,
  options: SyncEngineOptions = {}
): SyncEngine {
  const iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
  const importEpub = options.importEpub ?? defaultImportEpub;
  const relayWaitMs = options.relayWaitMs ?? RELAY_WAIT_MS;

  const identity = () => ensureDeviceIdentity(store);

  const device: Promise<SyncDevice> = identity().then(({ deviceId, name }) => ({
    deviceId,
    name,
  }));

  async function rememberPeer(
    payload: Pick<SignalPayload, "deviceId" | "name" | "publicKey">
  ): Promise<void> {
    const peers = await store.listPeers();
    const existing = peers.find((peer) => peer.deviceId === payload.deviceId);
    const record: PeerRecord = {
      deviceId: payload.deviceId,
      name: payload.name,
      publicKey: publicKeyFromCoordinates(payload.publicKey),
      pairedAt: existing?.pairedAt ?? Date.now(),
      lastSyncAt: existing?.lastSyncAt ?? null,
    };
    await store.putPeer(record);
  }

  async function markSynced(deviceId: string): Promise<void> {
    const peers = await store.listPeers();
    const peer = peers.find((item) => item.deviceId === deviceId);
    if (peer) {
      await store.putPeer({ ...peer, lastSyncAt: Date.now() });
    }
  }

  function guard<T>(
    session: Session,
    task: () => Promise<T>
  ): Promise<T | undefined> {
    return task().catch((error: unknown) => {
      if (!session.isCancelled) {
        session.emit({ type: "error", message: syncErrorMessage(error) });
      }
      session.teardown();
      return undefined;
    });
  }

  async function finish(
    session: Session,
    self: SyncDevice,
    peer: SyncDevice,
    sas: string,
    channel: RTCDataChannel,
    sasConfirmed: Promise<void>
  ): Promise<void> {
    await waitForChannelOpen(channel);
    session.emit({ type: "status", message: "Connected. Verifying…" });
    const run = runSyncProtocol({
      channel: channelFromDataChannel(channel),
      emit: (event) => session.emit(event),
      importEpub,
      peer,
      sas,
      sasConfirmed,
      self,
      store,
    });
    session.run = run;
    const result = await run.done;
    await markSynced(result.peer.deviceId);
    session.teardown();
  }

  function startManual(manual: ManualSessionOptions): SyncSession {
    const session = new Session(
      manual.role,
      manual.role === "offer" ? "answer" : null
    );

    guard(session, async () => {
      const me = await identity();
      const self: SyncDevice = { deviceId: me.deviceId, name: me.name };
      const pc = createPeerConnection(iceServers);
      session.pc = pc;

      let localSdp: string;
      let remote: SignalPayload;
      let channel: RTCDataChannel;

      if (manual.role === "offer") {
        channel = pc.createDataChannel(SYNC_CHANNEL_LABEL, { ordered: true });
        session.emit({ type: "status", message: "Preparing a pairing code…" });
        localSdp = await createOfferSdp(pc);
        session.emit({
          type: "signal-ready",
          role: "offer",
          code: encodeSignalCode({
            role: "offer",
            deviceId: me.deviceId,
            name: me.name,
            publicKey: publicKeyCoordinates(me.publicKey),
            sdp: localSdp,
          }),
        });
        session.emit({
          type: "status",
          message: "Waiting for the other device's reply code…",
        });
        remote = await session.remotePayload;
        if (remote.deviceId === me.deviceId) {
          throw new SyncError("self_pair", "That code came from this device.");
        }
        await pc.setRemoteDescription({ type: "answer", sdp: remote.sdp });
      } else {
        if (!manual.remoteCode) {
          throw new SyncError(
            "missing_code",
            "Scan or paste the other device's code first."
          );
        }
        remote = decodeSignalCode(manual.remoteCode, "offer");
        if (remote.deviceId === me.deviceId) {
          throw new SyncError("self_pair", "That code came from this device.");
        }
        const pending = waitForDataChannel(pc, ANSWER_WAIT_MS);
        pending.catch(ignore);
        localSdp = await createAnswerSdp(pc, remote.sdp);
        session.emit({
          type: "signal-ready",
          role: "answer",
          code: encodeSignalCode({
            role: "answer",
            deviceId: me.deviceId,
            name: me.name,
            publicKey: publicKeyCoordinates(me.publicKey),
            sdp: localSdp,
          }),
        });
        session.emit({
          type: "status",
          message: "Show this reply code to the other device…",
        });
        channel = await pending;
      }

      const keys = await deriveSharedKeys(
        me.privateKey,
        publicKeyFromCoordinates(remote.publicKey),
        [me.deviceId, remote.deviceId]
      );
      const offerSdp = manual.role === "offer" ? localSdp : remote.sdp;
      const answerSdp = manual.role === "offer" ? remote.sdp : localSdp;
      const sas = await shortAuthString(
        keys,
        dtlsFingerprint(offerSdp),
        dtlsFingerprint(answerSdp)
      );
      session.emit({ type: "sas", code: sas });

      const peer: SyncDevice = { deviceId: remote.deviceId, name: remote.name };
      // Persist the pairing once both users vouched for the digits; that is
      // the moment the two devices know they hold each other's real keys.
      const confirmed = session.sasConfirmed.then(async () => {
        await rememberPeer(remote);
      });
      confirmed.catch(ignore);
      await finish(session, self, peer, sas, channel, confirmed);
    });

    return session;
  }

  function startRelay(relayOptions: RelaySessionOptions): SyncSession {
    const session = new Session("offer", null);

    guard(session, async () => {
      const me = await identity();
      const self: SyncDevice = { deviceId: me.deviceId, name: me.name };
      const peers = await store.listPeers();
      const peerRecord = peers.find(
        (item) => item.deviceId === relayOptions.peerDeviceId
      );
      if (!peerRecord) {
        throw new SyncError(
          "unknown_peer",
          "That device is not paired with this one."
        );
      }
      const peer: SyncDevice = {
        deviceId: peerRecord.deviceId,
        name: peerRecord.name,
      };
      const keys = await deriveSharedKeys(me.privateKey, peerRecord.publicKey, [
        me.deviceId,
        peerRecord.deviceId,
      ]);
      const room = await roomId(keys);
      const offering = me.deviceId < peerRecord.deviceId;

      const signal = deferred<RelaySignal>();
      const peerPresent = deferred<void>();
      session.emit({ type: "status", message: "Connecting to the relay…" });
      const relay = await connectRelay(relayOptions.relayUrl, room, {
        onSignal: (payload) => {
          openEnvelope(keys, payload)
            .then((plain) =>
              signal.resolve(parseRelaySignal(plain, keys, peerRecord.deviceId))
            )
            .catch((error: unknown) =>
              signal.reject(
                error instanceof SyncError
                  ? error
                  : new SyncError(
                      "bad_envelope",
                      "The relay message could not be read."
                    )
              )
            );
        },
        onPeerJoined: () => peerPresent.resolve(),
        onClose: (reason) => {
          const error = new SyncError("relay_closed", reason);
          signal.reject(error);
          peerPresent.reject(error);
        },
      });
      session.relay = relay;
      if (relay.peersPresent > 0) {
        peerPresent.resolve();
      }

      const pc = createPeerConnection(iceServers);
      session.pc = pc;
      let channel: RTCDataChannel;
      let offerSdp: string;
      let answerSdp: string;

      const sendSignal = async (role: "offer" | "answer", sdp: string) => {
        const plain: RelaySignal = {
          role,
          sdp,
          fingerprint: dtlsFingerprint(sdp),
          deviceId: me.deviceId,
        };
        relay.send(await sealEnvelope(keys, JSON.stringify(plain)));
      };

      if (offering) {
        session.emit({
          type: "status",
          message: `Waiting for ${peer.name} to come online…`,
        });
        await withTimeout(
          peerPresent.promise,
          relayWaitMs,
          "relay_wait",
          `${peer.name} did not come online.`
        );
        channel = pc.createDataChannel(SYNC_CHANNEL_LABEL, { ordered: true });
        offerSdp = await createOfferSdp(pc);
        await sendSignal("offer", offerSdp);
        session.emit({
          type: "status",
          message: `Waiting for ${peer.name} to answer…`,
        });
        const answer = await withTimeout(
          signal.promise,
          relayWaitMs,
          "relay_wait",
          `${peer.name} did not answer.`
        );
        if (answer.role !== "answer") {
          throw new SyncError(
            "protocol",
            "The paired device sent the wrong kind of signal."
          );
        }
        answerSdp = answer.sdp;
        await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      } else {
        session.emit({ type: "status", message: `Waiting for ${peer.name}…` });
        const pending = waitForDataChannel(pc, relayWaitMs);
        pending.catch(ignore);
        const offer = await withTimeout(
          signal.promise,
          relayWaitMs,
          "relay_wait",
          `${peer.name} did not connect.`
        );
        if (offer.role !== "offer") {
          throw new SyncError(
            "protocol",
            "The paired device sent the wrong kind of signal."
          );
        }
        offerSdp = offer.sdp;
        answerSdp = await createAnswerSdp(pc, offerSdp);
        await sendSignal("answer", answerSdp);
        channel = await pending;
      }

      // Relay peers already hold each other's long-term keys: only a holder
      // of the pairing key could have sealed the envelope, and the sealed
      // fingerprint was checked against the SDP it arrived with. The SAS is
      // still computed and exchanged in `hello` as a consistency check, but
      // the user is not asked to compare digits.
      const sas = await shortAuthString(
        keys,
        dtlsFingerprint(offerSdp),
        dtlsFingerprint(answerSdp)
      );
      session.emit({ type: "status", message: "Pairing key verified." });
      relay.close();
      session.relay = null;
      await finish(session, self, peer, sas, channel, Promise.resolve());
    });

    return session;
  }

  return {
    device,
    async listPeers(): Promise<PairedDevice[]> {
      const peers = await store.listPeers();
      return peers
        .map((peer) => ({
          deviceId: peer.deviceId,
          name: peer.name,
          pairedAt: peer.pairedAt,
          lastSyncAt: peer.lastSyncAt,
        }))
        .sort(
          (a, b) => (b.lastSyncAt ?? b.pairedAt) - (a.lastSyncAt ?? a.pairedAt)
        );
    },
    forgetPeer: (deviceId) => store.deletePeer(deviceId),
    async renameDevice(name) {
      const me = await identity();
      await store.putSetting("device", {
        ...me,
        name: normalizeDeviceName(name),
      });
    },
    startManual,
    startRelay,
  };
}

function parseRelaySignal(
  plain: string,
  _keys: SharedKeys,
  peerDeviceId: string
): RelaySignal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new SyncError("bad_envelope", "The relay message is malformed.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SyncError("bad_envelope", "The relay message is malformed.");
  }
  const record = parsed as Record<string, unknown>;
  const role = record.role;
  if (
    (role !== "offer" && role !== "answer") ||
    typeof record.sdp !== "string" ||
    typeof record.fingerprint !== "string" ||
    record.deviceId !== peerDeviceId
  ) {
    throw new SyncError(
      "bad_envelope",
      "The relay message is not from the paired device."
    );
  }
  if (dtlsFingerprint(record.sdp) !== record.fingerprint) {
    throw new SyncError(
      "fingerprint_mismatch",
      "The connection description does not match its sealed fingerprint."
    );
  }
  return {
    role,
    sdp: record.sdp,
    fingerprint: record.fingerprint,
    deviceId: peerDeviceId,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: string,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SyncError(code, message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
