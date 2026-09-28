// biome-ignore lint/performance/noBarrelFile: This module is the public reading-session API used by the reader UI.
export {
  colorForReader,
  localReaderId,
  READER_COLORS,
  READER_ID_KEY,
  READER_NAME_KEY,
  rememberReaderName,
  storedReaderName,
} from "./presence";
export {
  MAX_CODE_LENGTH,
  MAX_COMMENT,
  MAX_NAME,
  normalizeReaderName,
} from "./protocol";
export type {
  HostOptions,
  JoinOptions,
  MemberView,
  ReadingSession,
  RoomPeek,
  RoomView,
  SessionOptions,
  ShareRole,
} from "./session";
export { createReadingSession, peekRoom } from "./session";
export type { Annotation, AnnotationAuthor, ContentLocator } from "./types";
