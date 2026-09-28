// biome-ignore-all lint/performance/noBarrelFile: the sync module's public entry point; internals stay private
export {
  decodeSignalCode,
  encodeSignalCode,
  SIGNAL_CODE_PREFIX,
} from "./codes";
export { createSyncEngine, type SyncEngineOptions } from "./engine";
export { SyncError, syncErrorMessage } from "./errors";
export { ensureDeviceIdentity, guessDeviceName } from "./identity";
export { createQrScanner, drawQrCode, type QrScanner, shareCode } from "./qr";
export { validateRelayUrl } from "./relay-signaling";
export type {
  ManualSessionOptions,
  PairedDevice,
  RelaySessionOptions,
  SyncDevice,
  SyncEngine,
  SyncEvent,
  SyncSession,
  SyncSummary,
} from "./types";
