import type { SyncChannel } from "./channel";
import { SyncError } from "./errors";

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];
export const SYNC_CHANNEL_LABEL = "leaflet-sync";
const GATHERING_TIMEOUT_MS = 3000;
const OPEN_TIMEOUT_MS = 30_000;
const FINGERPRINT_LINE = /^a=fingerprint:\s*(\S+)\s+([0-9A-Fa-f:]+)\s*$/mu;

export function createPeerConnection(
  iceServers: RTCIceServer[] = DEFAULT_ICE_SERVERS
): RTCPeerConnection {
  if (typeof RTCPeerConnection === "undefined") {
    throw new SyncError(
      "webrtc_unsupported",
      "This browser cannot open a direct connection to another device."
    );
  }
  return new RTCPeerConnection({ iceServers });
}

/** `a=fingerprint:sha-256 AB:CD:…` -> `sha-256 AB:CD:…` (upper-case hex). */
export function dtlsFingerprint(sdp: string): string {
  const match = FINGERPRINT_LINE.exec(sdp);
  if (!match) {
    throw new SyncError(
      "no_fingerprint",
      "The connection description is missing its security fingerprint."
    );
  }
  return `${match[1].toLowerCase()} ${match[2].toUpperCase()}`;
}

/** Resolve when ICE gathering finishes or the timeout passes (whichever first). */
export function waitForIceGathering(
  pc: RTCPeerConnection,
  timeoutMs = GATHERING_TIMEOUT_MS
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        finish();
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function localSdp(pc: RTCPeerConnection): string {
  const sdp = pc.localDescription?.sdp;
  if (!sdp) {
    throw new SyncError("no_sdp", "The connection description is empty.");
  }
  return sdp;
}

/** Caller creates the data channel first so it is part of the offer. */
export async function createOfferSdp(pc: RTCPeerConnection): Promise<string> {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  return localSdp(pc);
}

export async function createAnswerSdp(
  pc: RTCPeerConnection,
  offerSdp: string
): Promise<string> {
  await pc.setRemoteDescription({ type: "offer", sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitForIceGathering(pc);
  return localSdp(pc);
}

export function waitForDataChannel(
  pc: RTCPeerConnection,
  timeoutMs: number
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.ondatachannel = null;
      reject(
        new SyncError("timeout", "The other device did not connect in time.")
      );
    }, timeoutMs);
    pc.ondatachannel = (event) => {
      clearTimeout(timer);
      pc.ondatachannel = null;
      resolve(event.channel);
    };
  });
}

export function waitForChannelOpen(
  channel: RTCDataChannel,
  timeoutMs = OPEN_TIMEOUT_MS
): Promise<void> {
  if (channel.readyState === "open") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      channel.removeEventListener("open", onOpen);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(
        new SyncError(
          "connect_failed",
          "The devices could not reach each other. Check that both are online."
        )
      );
    };
    const timer = setTimeout(onClose, timeoutMs);
    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("error", onClose);
  });
}

/**
 * Adapt an `RTCDataChannel`. Binary frames arrive as `ArrayBuffer` (Safari
 * may still hand out Blobs, which are converted in arrival order).
 */
export function channelFromDataChannel(channel: RTCDataChannel): SyncChannel {
  channel.binaryType = "arraybuffer";
  const adapted: SyncChannel = {
    get bufferedAmount() {
      return channel.bufferedAmount;
    },
    get bufferedAmountLowThreshold() {
      return channel.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value: number) {
      channel.bufferedAmountLowThreshold = value;
    },
    close: () => channel.close(),
    onbufferedamountlow: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: (data) => {
      if (typeof data === "string") {
        channel.send(data);
      } else {
        channel.send(data);
      }
    },
  };
  let inbound: Promise<void> = Promise.resolve();
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const { data } = event;
    inbound = inbound.then(async () => {
      if (typeof data === "string" || data instanceof ArrayBuffer) {
        adapted.onmessage?.(data);
      } else if (data instanceof Blob) {
        adapted.onmessage?.(await data.arrayBuffer());
      } else if (ArrayBuffer.isView(data)) {
        adapted.onmessage?.(
          data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength
          ) as ArrayBuffer
        );
      }
    });
  };
  channel.onbufferedamountlow = () => adapted.onbufferedamountlow?.();
  channel.onclose = () => adapted.onclose?.();
  channel.onerror = () => adapted.onerror?.("The connection failed.");
  return adapted;
}
