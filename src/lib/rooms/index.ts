// biome-ignore-all lint/performance/noBarrelFile: the rooms module's public entry point
export {
  createRoom,
  DEFAULT_RELAY_URL,
  joinRoom,
  MAX_PLAINTEXT_BYTES,
  type RoomClient,
  type RoomClosedCode,
  type RoomEvent,
  type RoomMember,
  type RoomOptions,
  type RoomTransport,
  relayEndpoint,
  type SocketLike,
  validateRelayUrl,
} from "./client";
export {
  DEFAULT_JOIN_ORIGIN,
  defaultJoinOrigin,
  deriveRoomKeys,
  generateRoomCode,
  normalizeRoomCode,
  parseJoinUrl,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RoomKeys,
  roomCodeFromBytes,
  roomJoinUrl,
} from "./codes";
export { decodeJson } from "./envelope";
export { RoomError, type RoomErrorCode, roomErrorMessage } from "./errors";
export type { RoomChannel } from "./protocol";
