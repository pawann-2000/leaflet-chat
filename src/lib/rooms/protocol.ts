/**
 * Relay wire protocol (JSON text frames, ≤ 64 KiB), as seen by the client.
 *
 *   client → relay  { type: "join", room, create, hostSecret? }
 *   relay  → client { type: "joined", you, host, hostSecret?, locked, members }
 *                   { type: "error", code }
 *   client → relay  { type: "data", channel, payload, to? }
 *   relay  → client { type: "data", from, channel, payload }
 *   relay  → client { type: "member-joined", member } | { type: "member-left", id }
 *   client → relay  { type: "policy", locked } | { type: "kick", id }   (host only)
 *   relay  → client { type: "policy", locked }
 *   either          { type: "ping" } / { type: "pong" }
 *
 * The relay never sees a code, a book, a note or a position: `payload` is a
 * sealed envelope and `room` is a hash of the code.
 */

export type RoomChannel = "notes" | "presence" | "control" | "signal" | "bulk";

export const ROOM_CHANNELS: readonly RoomChannel[] = [
  "notes",
  "presence",
  "control",
  "signal",
  "bulk",
];

export const MAX_FRAME_CHARS = 64 * 1024;
export const MAX_MEMBERS = 16;
export const MAX_ID_LENGTH = 64;
export const MAX_HOST_SECRET_LENGTH = 64;
export const ROOM_ID_PATTERN = /^[0-9a-f]{32}$/u;

export type RelayErrorCode =
  | "bad_request"
  | "forbidden"
  | "locked"
  | "not_found"
  | "rate_limited"
  | "room_full";

export interface WireMember {
  host: boolean;
  id: string;
  joinedAt: number;
}

export type ClientFrame =
  | { type: "join"; room: string; create: boolean; hostSecret?: string }
  | { type: "data"; channel: RoomChannel; payload: string; to?: string }
  | { type: "policy"; locked: boolean }
  | { type: "kick"; id: string }
  | { type: "ping" }
  | { type: "pong" };

export type ServerFrame =
  | {
      type: "joined";
      you: string;
      host: boolean;
      hostSecret?: string;
      locked: boolean;
      members: WireMember[];
    }
  | { type: "error"; code: RelayErrorCode }
  | { type: "data"; from: string; channel: RoomChannel; payload: string }
  | { type: "member-joined"; member: WireMember }
  | { type: "member-left"; id: string }
  | { type: "policy"; locked: boolean }
  | { type: "ping" }
  | { type: "pong" };

type Record_ = Record<string, unknown>;

const ERROR_CODES = new Set<string>([
  "bad_request",
  "forbidden",
  "locked",
  "not_found",
  "rate_limited",
  "room_full",
]);

function isRecord(value: unknown): value is Record_ {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH
  );
}

export function isRoomChannel(value: unknown): value is RoomChannel {
  return (
    typeof value === "string" && (ROOM_CHANNELS as string[]).includes(value)
  );
}

function member(value: unknown): WireMember | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !isId(value.id) ||
    typeof value.host !== "boolean" ||
    typeof value.joinedAt !== "number" ||
    !Number.isFinite(value.joinedAt)
  ) {
    return null;
  }
  return { id: value.id, host: value.host, joinedAt: value.joinedAt };
}

function parseJoined(frame: Record_): ServerFrame | null {
  if (
    !(
      isId(frame.you) &&
      typeof frame.host === "boolean" &&
      typeof frame.locked === "boolean" &&
      Array.isArray(frame.members)
    )
  ) {
    return null;
  }
  const members: WireMember[] = [];
  for (const entry of frame.members) {
    const item = member(entry);
    if (!item) {
      return null;
    }
    members.push(item);
  }
  const parsed: ServerFrame = {
    type: "joined",
    you: frame.you,
    host: frame.host,
    locked: frame.locked,
    members,
  };
  if (typeof frame.hostSecret === "string" && frame.hostSecret) {
    parsed.hostSecret = frame.hostSecret.slice(0, MAX_HOST_SECRET_LENGTH);
  }
  return parsed;
}

function parseData(frame: Record_): ServerFrame | null {
  return isId(frame.from) &&
    isRoomChannel(frame.channel) &&
    typeof frame.payload === "string" &&
    frame.payload.length <= MAX_FRAME_CHARS
    ? {
        type: "data",
        from: frame.from,
        channel: frame.channel,
        payload: frame.payload,
      }
    : null;
}

const PARSERS: Record<string, (frame: Record_) => ServerFrame | null> = {
  joined: parseJoined,
  error: (frame) =>
    typeof frame.code === "string" && ERROR_CODES.has(frame.code)
      ? { type: "error", code: frame.code as RelayErrorCode }
      : null,
  data: parseData,
  "member-joined": (frame) => {
    const item = member(frame.member);
    return item ? { type: "member-joined", member: item } : null;
  },
  "member-left": (frame) =>
    isId(frame.id) ? { type: "member-left", id: frame.id } : null,
  policy: (frame) =>
    typeof frame.locked === "boolean"
      ? { type: "policy", locked: frame.locked }
      : null,
  ping: () => ({ type: "ping" }),
  pong: () => ({ type: "pong" }),
};

/** Parse one frame from the relay; `null` for anything malformed (dropped). */
export function parseServerFrame(text: unknown): ServerFrame | null {
  if (typeof text !== "string" || text.length > MAX_FRAME_CHARS) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return null;
  }
  const parser = Object.hasOwn(PARSERS, parsed.type)
    ? PARSERS[parsed.type]
    : null;
  return parser ? parser(parsed) : null;
}

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
