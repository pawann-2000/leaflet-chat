/**
 * Contracts between the sync engine and the UI.
 *
 * Pairing and syncing both ride on one WebRTC data channel between two
 * browsers. Establishing that channel needs the two sides to swap a signaling
 * blob (SDP + ICE candidates) once per session. Two signaling transports exist:
 *
 * - `manual`: the blob is shown as a QR code or copyable text on one device and
 *   scanned or pasted on the other, then the answer travels back the same way.
 *   No server is involved. Both devices must be at hand.
 * - `relay`: the blobs travel through a user-supplied WebSocket relay. Every
 *   message is encrypted with a key derived from the pairing, so the relay can
 *   route but not read or forge signaling. Lets paired devices sync without
 *   scanning anything.
 */

export interface SyncDevice {
  deviceId: string;
  name: string;
}

export interface PairedDevice extends SyncDevice {
  lastSyncAt: number | null;
  pairedAt: number;
}

/** Progress of one sync run, for the UI log. */
export type SyncEvent =
  | { type: "status"; message: string }
  | { type: "signal-ready"; code: string; role: "offer" | "answer" }
  | { type: "sas"; code: string }
  | { type: "connected"; peer: SyncDevice }
  | {
      type: "transfer";
      direction: "send" | "receive";
      label: string;
      done: number;
      total: number;
    }
  | { type: "complete"; summary: SyncSummary }
  | { type: "error"; message: string };

export interface SyncSummary {
  booksReceived: number;
  booksSent: number;
  progressReceived: number;
  progressSent: number;
  trustedReceived: number;
  trustedSent: number;
}

/**
 * One pairing or sync attempt. The UI drives it step by step:
 *
 *   const session = engine.startManual({ role: "offer" })
 *   session.events -> "signal-ready" (show QR / text)
 *   session.acceptRemoteCode(scannedText)          // offer side receives the answer
 *   session.events -> "sas" (both screens show the same 6 digits)
 *   session.confirmSas()                           // user checked they match
 *   session.events -> "connected" -> "transfer"* -> "complete"
 *
 * The answer side is symmetric: `startManual({ role: "answer", remoteCode })`
 * emits its own "signal-ready" for the code to send back.
 */
export interface SyncSession {
  /** Feed the code produced by the other device (manual transport only). */
  acceptRemoteCode(code: string): Promise<void>;
  /** Abort the session and release the peer connection. */
  cancel(): void;
  /** The user verified the short authentication string matches on both screens. */
  confirmSas(): void;
  readonly id: string;
  readonly role: "offer" | "answer";
  subscribe(listener: (event: SyncEvent) => void): () => void;
}

export interface ManualSessionOptions {
  /** Required for the answer role: the offer code scanned or pasted from the other device. */
  remoteCode?: string;
  role: "offer" | "answer";
}

export interface RelaySessionOptions {
  peerDeviceId: string;
  relayUrl: string;
}

export interface SyncEngine {
  readonly device: Promise<SyncDevice>;
  forgetPeer(deviceId: string): Promise<void>;
  listPeers(): Promise<PairedDevice[]>;
  renameDevice(name: string): Promise<void>;
  /** Pair with, or sync against, a device that is physically present. */
  startManual(options: ManualSessionOptions): SyncSession;
  /** Sync with an already paired device through a relay. */
  startRelay(options: RelaySessionOptions): SyncSession;
}
