/**
 * The transport the protocol runs on. `RTCDataChannel` is adapted to this in
 * `webrtc.ts`; tests wire two in-memory ends together.
 */
export interface SyncChannel {
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  close(): void;
  onbufferedamountlow: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((message: string) => void) | null;
  onmessage: ((data: string | ArrayBuffer) => void) | null;
  send(data: string | ArrayBuffer): void;
}
