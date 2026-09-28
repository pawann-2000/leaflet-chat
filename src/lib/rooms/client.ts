/**
 * Room client: one WebSocket to the relay, every payload sealed end to end.
 *
 * Lifecycle: `connecting` → `open` (a `joined` frame arrived) → `closed`.
 * A dropped socket reconnects with backoff while the tab is alive; the
 * `open` event fires again after each successful re-join so consumers can
 * re-announce themselves and resync (Yjs makes that idempotent). A host
 * reclaims its seat by presenting the `hostSecret` it received on creation.
 */
import { deriveRoomKeys, generateRoomCode, normalizeRoomCode } from "./codes";
import {
  decodePayload,
  decodePlaintext,
  encodePayload,
  encodePlaintext,
  envelopeAad,
  open as openEnvelope,
  SequenceCounter,
  SequenceTracker,
  seal,
} from "./envelope";
import { RoomError, type RoomErrorCode } from "./errors";
import {
  encodeClientFrame,
  MAX_FRAME_CHARS,
  parseServerFrame,
  type RelayErrorCode,
  ROOM_ID_PATTERN,
  type RoomChannel,
  type ServerFrame,
  type WireMember,
} from "./protocol";

export type { RoomChannel } from "./protocol";

export interface RoomMember {
  id: string;
  isHost: boolean;
  joinedAt: number;
}

export type RoomClosedCode =
  | "bad_code"
  | "closed"
  | "forbidden"
  | "kicked"
  | "network"
  | "not_found"
  | "room_full";

export type RoomEvent =
  | { type: "open"; you: string; members: RoomMember[]; locked: boolean }
  | { type: "member-joined"; member: RoomMember }
  | { type: "member-left"; id: string }
  | {
      type: "message";
      from: string;
      channel: RoomChannel;
      data: Uint8Array;
      kind: "bytes" | "json";
    }
  | { type: "policy"; locked: boolean }
  | { type: "reconnecting"; attempt: number }
  | { type: "closed"; code: RoomClosedCode; reason: string };

export interface RoomClient {
  /** Bytes queued on the socket and not yet handed to the network. */
  readonly bufferedAmount: number;
  close(): void;
  readonly id: string;
  readonly isHost: boolean;
  kick(id: string): void;
  readonly locked: boolean;
  readonly members: readonly RoomMember[];
  /** Objects are JSON-encoded; `Uint8Array` travels as raw bytes. Omit `to` to reach everyone else. */
  send(channel: RoomChannel, data: Uint8Array | object, to?: string): void;
  setLocked(locked: boolean): void;
  readonly state: "closed" | "connecting" | "open";
  subscribe(listener: (event: RoomEvent) => void): () => void;
}

/** The subset of `WebSocket` the client relies on; tests supply a fake. */
export interface SocketLike {
  readonly bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  readonly readyState: number;
  send(data: string): void;
}

/** Where a host keeps the secret that reclaims its seat after a reload. */
export interface SecretStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface RoomTransport {
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Defaults to `sessionStorage`; `null` keeps host secrets in memory only. */
  storage?: SecretStorage | null;
}

export interface RoomOptions {
  code: string;
  /** Create the room (become host) when it does not exist yet. */
  create: boolean;
  /** Attached before dialing, so the first `open` event is never missed. */
  listener?: (event: RoomEvent) => void;
  relayUrl: string;
  transport?: RoomTransport;
}

export const DEFAULT_RELAY_URL = "wss://rooms.leaflet.chat";
/** Largest plaintext that still fits a 64 KiB relay frame after sealing and base64. */
export const MAX_PLAINTEXT_BYTES = 44 * 1024;
const CONNECT_TIMEOUT_MS = 12_000;
const LIVENESS_MS = 75_000;
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const MAX_INVALID_FRAMES = 20;
const SOCKET_OPEN = 1;
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const CLOSE_KICKED = 4000;
const CLOSE_REPLACED = 4001;
const CLOSE_NOT_FOUND = 4404;
const CLOSE_FULL = 4409;
const TRAILING_SLASHES = /\/+$/u;

const ignore = (): undefined => undefined;

function relayErrorToClosed(code: RelayErrorCode): {
  code: RoomClosedCode;
  reason: string;
} {
  switch (code) {
    case "not_found":
      return {
        code: "not_found",
        reason: "That room does not exist any more. Ask for a new code.",
      };
    case "room_full":
      return {
        code: "room_full",
        reason: "That room is full (16 readers).",
      };
    case "forbidden":
      return { code: "forbidden", reason: "The relay refused that action." };
    case "rate_limited":
      return {
        code: "closed",
        reason: "The relay closed the connection for sending too fast.",
      };
    case "locked":
      return {
        code: "forbidden",
        reason: "The host has locked this room for guests.",
      };
    default:
      return { code: "closed", reason: "The relay refused the request." };
  }
}

export function validateRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new RoomError(
      "bad_relay_url",
      "The relay address is not a valid URL."
    );
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new RoomError(
      "bad_relay_url",
      "The relay address must start with wss:// or ws://."
    );
  }
  if (url.username || url.password) {
    throw new RoomError(
      "bad_relay_url",
      "The relay address cannot contain credentials."
    );
  }
  if (url.search || url.hash) {
    throw new RoomError(
      "bad_relay_url",
      "The relay address cannot contain a query or fragment."
    );
  }
  return url.toString();
}

/** `wss://host[/prefix]/v1/rooms/<roomId>` */
export function relayEndpoint(relayUrl: string, roomId: string): string {
  if (!ROOM_ID_PATTERN.test(roomId)) {
    throw new RoomError("bad_code", "The room id is malformed.");
  }
  const url = new URL(validateRelayUrl(relayUrl));
  const prefix = url.pathname.replace(TRAILING_SLASHES, "");
  url.pathname = `${prefix}/v1/rooms/${roomId}`;
  return url.toString();
}

function hostSecretStorageKey(roomId: string): string {
  return `leaflet-room-host:${roomId}`;
}

function defaultStorage(): SecretStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStoredHostSecret(
  storage: SecretStorage | null,
  roomId: string
): string | null {
  try {
    return storage?.getItem(hostSecretStorageKey(roomId)) ?? null;
  } catch {
    return null;
  }
}

function writeStoredHostSecret(
  storage: SecretStorage | null,
  roomId: string,
  secret: string | null
): void {
  try {
    if (secret) {
      storage?.setItem(hostSecretStorageKey(roomId), secret);
    } else {
      storage?.removeItem(hostSecretStorageKey(roomId));
    }
  } catch {
    // Private mode: the secret simply lives in memory for this session.
  }
}

function defaultCreateSocket(url: string): SocketLike {
  if (typeof WebSocket === "undefined") {
    throw new RoomError(
      "unsupported",
      "This browser cannot open WebSocket connections."
    );
  }
  return new WebSocket(url) as unknown as SocketLike;
}

function toMember(wire: WireMember): RoomMember {
  return { id: wire.id, isHost: wire.host, joinedAt: wire.joinedAt };
}

class Room implements RoomClient {
  private readonly endpoint: string;
  private readonly roomId: string;
  private readonly key: CryptoKey;
  private readonly transport: Required<Omit<RoomTransport, "storage">>;
  private readonly storage: SecretStorage | null;
  private readonly listeners = new Set<(event: RoomEvent) => void>();
  private readonly tracker = new SequenceTracker();
  private readonly counter = new SequenceCounter();
  private readonly memberList: RoomMember[] = [];
  private socket: SocketLike | null = null;
  private you = "";
  private host = false;
  private lockedState = false;
  private create: boolean;
  private hostSecret: string | null;
  private status: "closed" | "connecting" | "open" = "connecting";
  private everJoined = false;
  private attempt = 0;
  private invalid = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private firstJoin: {
    reject: (error: RoomError) => void;
    resolve: () => void;
  } | null = null;

  constructor(
    endpoint: string,
    roomId: string,
    key: CryptoKey,
    create: boolean,
    transport: RoomTransport
  ) {
    this.endpoint = endpoint;
    this.roomId = roomId;
    this.key = key;
    this.create = create;
    this.storage =
      transport.storage === undefined ? defaultStorage() : transport.storage;
    this.hostSecret = readStoredHostSecret(this.storage, roomId);
    this.transport = {
      createSocket: transport.createSocket ?? defaultCreateSocket,
      now: transport.now ?? (() => Date.now()),
      setTimeout:
        transport.setTimeout ??
        ((fn, ms) => setTimeout(fn, ms) as ReturnType<typeof setTimeout>),
      clearTimeout:
        transport.clearTimeout ?? ((handle) => clearTimeout(handle)),
    };
  }

  get id(): string {
    return this.you;
  }
  get isHost(): boolean {
    return this.host;
  }
  get locked(): boolean {
    return this.lockedState;
  }
  get members(): readonly RoomMember[] {
    return this.memberList;
  }
  get state(): "closed" | "connecting" | "open" {
    return this.status;
  }
  get bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  subscribe(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Resolves after the first `joined`; rejects when the relay refuses. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.firstJoin = { resolve, reject };
      this.dial();
    });
  }

  private emit(event: RoomEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  private dial(): void {
    if (this.status === "closed") {
      return;
    }
    let socket: SocketLike;
    try {
      socket = this.transport.createSocket(this.endpoint);
    } catch (error) {
      this.finish(
        "network",
        error instanceof Error
          ? error.message
          : "The relay could not be reached."
      );
      return;
    }
    this.socket = socket;
    this.connectTimer = this.transport.setTimeout(() => {
      this.connectTimer = null;
      socket.close(CLOSE_GOING_AWAY, "connect timeout");
    }, CONNECT_TIMEOUT_MS);
    socket.onopen = () => {
      const join = {
        type: "join" as const,
        room: this.roomId,
        create: this.create,
        ...(this.hostSecret ? { hostSecret: this.hostSecret } : {}),
      };
      socket.send(encodeClientFrame(join));
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.touch();
      const frame = parseServerFrame(event.data);
      if (!frame) {
        this.countInvalid();
        return;
      }
      this.receive(frame);
    };
    socket.onerror = ignore;
    socket.onclose = (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.socket = null;
      this.clearTimers();
      this.onSocketClosed(event.code, event.reason);
    };
  }

  private clearTimers(): void {
    if (this.connectTimer !== null) {
      this.transport.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (this.livenessTimer !== null) {
      this.transport.clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /** Any frame proves the socket is alive; a long silence forces a reconnect. */
  private touch(): void {
    if (this.livenessTimer !== null) {
      this.transport.clearTimeout(this.livenessTimer);
    }
    this.livenessTimer = this.transport.setTimeout(() => {
      this.livenessTimer = null;
      this.socket?.close(CLOSE_GOING_AWAY, "no traffic");
    }, LIVENESS_MS);
  }

  private countInvalid(): void {
    this.invalid += 1;
    if (this.invalid >= MAX_INVALID_FRAMES) {
      this.finish("closed", "Too many unreadable messages arrived.");
    }
  }

  private onSocketClosed(code: number, reason: string): void {
    if (this.status === "closed") {
      return;
    }
    if (code === CLOSE_KICKED) {
      this.finish("kicked", "The host removed you from the room.");
      return;
    }
    if (code === CLOSE_NOT_FOUND) {
      this.finish("not_found", relayErrorToClosed("not_found").reason);
      return;
    }
    if (code === CLOSE_FULL) {
      this.finish("room_full", relayErrorToClosed("room_full").reason);
      return;
    }
    if (code === CLOSE_REPLACED) {
      this.finish("closed", "This seat was taken over by another tab.");
      return;
    }
    if (!this.everJoined) {
      this.finish(
        "network",
        reason || "The relay could not be reached. Check the relay address."
      );
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.status === "closed") {
      return;
    }
    this.status = "connecting";
    this.attempt += 1;
    const base = Math.min(
      BACKOFF_MAX_MS,
      BACKOFF_MIN_MS * 2 ** Math.min(this.attempt - 1, 5)
    );
    const jitter = base * (0.5 + Math.random() * 0.5);
    this.emit({ type: "reconnecting", attempt: this.attempt });
    this.backoffTimer = this.transport.setTimeout(() => {
      this.backoffTimer = null;
      this.dial();
    }, Math.round(jitter));
  }

  private receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "joined":
        this.onJoined(frame);
        return;
      case "error":
        this.onError(frame.code);
        return;
      case "data":
        this.onData(frame);
        return;
      case "member-joined":
        if (!this.memberList.some((item) => item.id === frame.member.id)) {
          const member = toMember(frame.member);
          this.memberList.push(member);
          this.emit({ type: "member-joined", member });
        }
        return;
      case "member-left": {
        const index = this.memberList.findIndex((item) => item.id === frame.id);
        if (index >= 0) {
          this.memberList.splice(index, 1);
          this.tracker.forget(frame.id);
          this.emit({ type: "member-left", id: frame.id });
        }
        return;
      }
      case "policy":
        this.lockedState = frame.locked;
        this.emit({ type: "policy", locked: frame.locked });
        return;
      case "ping":
        this.rawSend({ type: "pong" });
        return;
      case "pong":
        return;
      default:
        return;
    }
  }

  private onJoined(frame: Extract<ServerFrame, { type: "joined" }>): void {
    if (this.connectTimer !== null) {
      this.transport.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.you = frame.you;
    this.host = frame.host;
    this.lockedState = frame.locked;
    if (frame.hostSecret) {
      this.hostSecret = frame.hostSecret;
      writeStoredHostSecret(this.storage, this.roomId, frame.hostSecret);
    }
    // After the first join, later dials must never create a second room.
    this.create = false;
    this.attempt = 0;
    this.memberList.splice(
      0,
      this.memberList.length,
      ...frame.members.filter((item) => item.id !== frame.you).map(toMember)
    );
    this.tracker.clear();
    this.status = "open";
    this.everJoined = true;
    const pending = this.firstJoin;
    this.firstJoin = null;
    pending?.resolve();
    this.emit({
      type: "open",
      you: frame.you,
      members: [...this.memberList],
      locked: frame.locked,
    });
  }

  private onError(code: RelayErrorCode): void {
    const closed = relayErrorToClosed(code);
    if (!this.everJoined) {
      this.finish(closed.code, closed.reason);
      return;
    }
    if (code === "not_found") {
      this.finish("not_found", closed.reason);
    }
    // Other errors while joined (locked/forbidden/rate_limited/bad_request)
    // are per-request; the relay closes the socket itself if they persist.
  }

  private onData(frame: Extract<ServerFrame, { type: "data" }>): void {
    let decoded: ReturnType<typeof decodePayload>;
    try {
      decoded = decodePayload(frame.payload);
    } catch {
      this.countInvalid();
      return;
    }
    if (!this.tracker.accept(frame.from, decoded.seq)) {
      this.countInvalid();
      return;
    }
    const aad = envelopeAad(
      this.roomId,
      frame.from,
      frame.channel,
      decoded.seq
    );
    openEnvelope(this.key, decoded.envelope, aad).then(
      (plaintext) => {
        if (this.status === "closed") {
          return;
        }
        let body: ReturnType<typeof decodePlaintext>;
        try {
          body = decodePlaintext(plaintext);
        } catch {
          this.countInvalid();
          return;
        }
        this.emit({
          type: "message",
          from: frame.from,
          channel: frame.channel,
          data: body.data,
          kind: body.kind,
        });
      },
      () => this.countInvalid()
    );
  }

  private rawSend(frame: Parameters<typeof encodeClientFrame>[0]): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return;
    }
    try {
      socket.send(encodeClientFrame(frame));
    } catch {
      socket.close(CLOSE_GOING_AWAY, "send failed");
    }
  }

  send(channel: RoomChannel, data: Uint8Array | object, to?: string): void {
    if (this.status === "closed") {
      throw new RoomError("closed", "The room connection is closed.");
    }
    const plaintext = encodePlaintext(data);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new RoomError(
        "too_large",
        "This message is too large for the room relay."
      );
    }
    const seq = this.counter.take();
    const from = this.you;
    const aad = envelopeAad(this.roomId, from, channel, seq);
    this.sendChain = this.sendChain
      .then(async () => {
        const sealed = await seal(this.key, plaintext, aad);
        if (this.status === "closed" || this.you !== from) {
          return;
        }
        const payload = encodePayload(seq, sealed);
        const frame = {
          type: "data" as const,
          channel,
          payload,
          ...(to ? { to } : {}),
        };
        const text = encodeClientFrame(frame);
        if (text.length > MAX_FRAME_CHARS) {
          throw new RoomError(
            "too_large",
            "This message is too large for the room relay."
          );
        }
        this.rawSend(frame);
      })
      .catch((error: unknown) => {
        if (error instanceof RoomError && error.code === "too_large") {
          return;
        }
        this.finish(
          "network",
          error instanceof Error
            ? error.message
            : "The room message could not be sealed."
        );
      });
  }

  setLocked(locked: boolean): void {
    if (!this.host) {
      throw new RoomError("forbidden", "Only the host can lock the room.");
    }
    this.rawSend({ type: "policy", locked });
  }

  kick(id: string): void {
    if (!this.host) {
      throw new RoomError("forbidden", "Only the host can remove readers.");
    }
    this.rawSend({ type: "kick", id });
  }

  close(): void {
    this.finish("closed", "You left the room.");
  }

  private finish(code: RoomClosedCode, reason: string): void {
    if (this.status === "closed") {
      return;
    }
    this.status = "closed";
    this.clearTimers();
    if (this.backoffTimer !== null) {
      this.transport.clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try {
        socket.close(CLOSE_NORMAL, "leaving");
      } catch {
        // Already closed.
      }
    }
    if (code === "kicked" || code === "not_found") {
      writeStoredHostSecret(this.storage, this.roomId, null);
    }
    const pending = this.firstJoin;
    this.firstJoin = null;
    const asError: RoomErrorCode = code;
    pending?.reject(new RoomError(asError, reason));
    this.memberList.length = 0;
    this.emit({ type: "closed", code, reason });
    this.listeners.clear();
  }
}

async function connect(options: RoomOptions): Promise<{
  client: RoomClient;
  code: string;
}> {
  const code = normalizeRoomCode(options.code);
  if (!code) {
    throw new RoomError("bad_code", "That is not a Leaflet room code.");
  }
  const keys = await deriveRoomKeys(code);
  const endpoint = relayEndpoint(options.relayUrl, keys.roomId);
  const room = new Room(
    endpoint,
    keys.roomId,
    keys.key,
    options.create,
    options.transport ?? {}
  );
  if (options.listener) {
    room.subscribe(options.listener);
  }
  await room.connect();
  return { client: room, code };
}

/** Host a room. A fresh code is generated unless one is supplied (paired devices derive theirs). */
export function createRoom(options: {
  code?: string;
  listener?: (event: RoomEvent) => void;
  relayUrl: string;
  transport?: RoomTransport;
}): Promise<{ client: RoomClient; code: string }> {
  return connect({
    code: options.code ?? generateRoomCode(),
    create: true,
    listener: options.listener,
    relayUrl: options.relayUrl,
    transport: options.transport,
  });
}

/** Join an existing room by code. Rejects with `not_found` when nobody created it. */
export async function joinRoom(options: {
  code: string;
  listener?: (event: RoomEvent) => void;
  relayUrl: string;
  transport?: RoomTransport;
}): Promise<RoomClient> {
  const { client } = await connect({
    code: options.code,
    create: false,
    listener: options.listener,
    relayUrl: options.relayUrl,
    transport: options.transport,
  });
  return client;
}
