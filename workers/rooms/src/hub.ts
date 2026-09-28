/**
 * Pure room logic shared by the Cloudflare Durable Object and the Node dev
 * relay. No I/O, no timers, no platform APIs: every method takes `now` and
 * returns the actions the transport must perform.
 *
 * What a room knows: who is connected (opaque socket ids), which of them is
 * the host, whether the host locked the room, and a host secret that lets the
 * creator reclaim the host seat after a reconnect. Payloads are never parsed
 * beyond the JSON envelope: they are sealed by the clients.
 */

export type Channel = "notes" | "presence" | "control" | "signal" | "bulk";

export interface MemberInfo {
  host: boolean;
  id: string;
  joinedAt: number;
}

export interface PersistedState {
  createdAt: number | null;
  emptySince: number | null;
  hostSecret: string | null;
  locked: boolean;
}

export type ErrorCode =
  | "bad_request"
  | "forbidden"
  | "locked"
  | "not_found"
  | "rate_limited"
  | "room_full";

export type ServerFrame =
  | {
      type: "joined";
      you: string;
      host: boolean;
      hostSecret?: string;
      locked: boolean;
      members: MemberInfo[];
    }
  | { type: "error"; code: ErrorCode }
  | { type: "data"; from: string; channel: Channel; payload: string }
  | { type: "member-joined"; member: MemberInfo }
  | { type: "member-left"; id: string }
  | { type: "policy"; locked: boolean }
  | { type: "ping" }
  | { type: "pong" };

export type Action =
  /** Deliver a frame to one socket, to everyone but `from`, or to all members. */
  | { to: string | "others" | "all"; frame: ServerFrame; from?: string }
  /** Close a socket with a WebSocket close code and reason. */
  | { close: string; code: number; reason: string }
  /** Schedule (`number`) or cancel (`null`) deletion of the room state. */
  | { deleteAt: number | null }
  /** The persisted state changed; write it through. */
  | { persist: PersistedState }
  /** The room has been empty long enough: wipe its state. */
  | { expire: true };

export interface HubOptions {
  /** Bytes allowed per second per socket (and burst). */
  bytesPerSecond?: number;
  /** Close a socket after this many missed pings. */
  dropAfterMissedPings?: number;
  /** Delete room state this long after the last member left. */
  expireAfterMs?: number;
  frameBurst?: number;
  framesPerSecond?: number;
  /** Close a socket that never joins within this time. */
  joinTimeoutMs?: number;
  maxFrameChars?: number;
  maxMembers?: number;
  /** Ping a socket after this long without traffic. */
  pingAfterMs?: number;
  /** Random hex string for host secrets. */
  random?: () => string;
  /** Strikes (rate-limit or malformed frames) before the socket is closed. */
  strikes?: number;
}

export const CLOSE_POLICY = 1008;
export const CLOSE_TOO_BIG = 1009;
export const CLOSE_KICKED = 4000;
export const CLOSE_REPLACED = 4001;
export const CLOSE_IDLE = 4002;
export const CLOSE_JOIN_TIMEOUT = 4003;
export const CLOSE_NOT_FOUND = 4404;
export const CLOSE_FULL = 4409;

const CHANNELS: readonly Channel[] = [
  "notes",
  "presence",
  "control",
  "signal",
  "bulk",
];
const HOST_ONLY_WHEN_LOCKED: readonly Channel[] = ["notes", "bulk"];
const ROOM_ID = /^[0-9a-f]{32}$/u;
const MAX_ID = 64;
const MAX_SECRET = 64;

interface Bucket {
  bytes: number;
  frames: number;
  updatedAt: number;
}

interface Socket {
  attachedAt: number;
  bucket: Bucket;
  lastPingAt: number;
  lastSeenAt: number;
  member: MemberInfo | null;
  missedPings: number;
  strikes: number;
}

interface Limits {
  bytesPerSecond: number;
  dropAfterMissedPings: number;
  expireAfterMs: number;
  frameBurst: number;
  framesPerSecond: number;
  joinTimeoutMs: number;
  maxFrameChars: number;
  maxMembers: number;
  pingAfterMs: number;
  strikes: number;
}

const DEFAULTS: Limits = {
  bytesPerSecond: 2 * 1024 * 1024,
  dropAfterMissedPings: 2,
  expireAfterMs: 24 * 60 * 60 * 1000,
  frameBurst: 80,
  framesPerSecond: 40,
  joinTimeoutMs: 10_000,
  maxFrameChars: 64 * 1024,
  maxMembers: 16,
  pingAfterMs: 30_000,
  strikes: 3,
};

function defaultRandom(): string {
  const bytes = new Uint8Array(16);
  const api = (globalThis as { crypto?: Crypto }).crypto;
  if (!api?.getRandomValues) {
    throw new Error("A secure random source is required for host secrets.");
  }
  api.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_ID
  );
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as string[]).includes(value);
}

/** Constant-time string comparison for the host secret. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: constant-time comparison
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export class RoomHub {
  readonly roomId: string;
  private readonly limits: Limits;
  private readonly random: () => string;
  private readonly sockets = new Map<string, Socket>();
  private persisted: PersistedState;

  constructor(
    roomId: string,
    state: Partial<PersistedState> = {},
    options: HubOptions = {}
  ) {
    if (!ROOM_ID.test(roomId)) {
      throw new Error("A room id is 32 lowercase hex characters.");
    }
    this.roomId = roomId;
    this.limits = { ...DEFAULTS, ...stripUndefined(options) };
    this.random = options.random ?? defaultRandom;
    this.persisted = {
      createdAt: state.createdAt ?? null,
      emptySince: state.emptySince ?? null,
      hostSecret: state.hostSecret ?? null,
      locked: state.locked ?? false,
    };
  }

  /** Current persisted state (a copy). */
  get state(): PersistedState {
    return { ...this.persisted };
  }

  get members(): MemberInfo[] {
    const list: MemberInfo[] = [];
    for (const socket of this.sockets.values()) {
      if (socket.member) {
        list.push({ ...socket.member });
      }
    }
    return list.sort((a, b) => a.joinedAt - b.joinedAt);
  }

  memberOf(socketId: string): MemberInfo | null {
    const member = this.sockets.get(socketId)?.member;
    return member ? { ...member } : null;
  }

  private newSocket(now: number): Socket {
    return {
      attachedAt: now,
      bucket: {
        bytes: this.limits.bytesPerSecond,
        frames: this.limits.frameBurst,
        updatedAt: now,
      },
      lastPingAt: now,
      lastSeenAt: now,
      member: null,
      missedPings: 0,
      strikes: 0,
    };
  }

  /** A socket was accepted; it must send `join` within `joinTimeoutMs`. */
  attach(socketId: string, now: number): Action[] {
    if (!this.sockets.has(socketId)) {
      this.sockets.set(socketId, this.newSocket(now));
    }
    return [];
  }

  /** Re-register a member after the transport woke up from hibernation. */
  restore(socketId: string, member: MemberInfo, now: number): void {
    const socket = this.newSocket(now);
    socket.member = { ...member };
    this.sockets.set(socketId, socket);
    if (this.persisted.emptySince !== null) {
      this.persisted.emptySince = null;
    }
  }

  private strike(socketId: string, socket: Socket, code: ErrorCode): Action[] {
    socket.strikes += 1;
    const actions: Action[] = [
      { to: socketId, frame: { type: "error", code } },
    ];
    if (socket.strikes >= this.limits.strikes) {
      actions.push(
        { close: socketId, code: CLOSE_POLICY, reason: code },
        ...this.leave(socketId, socket.lastSeenAt)
      );
    }
    return actions;
  }

  private refill(bucket: Bucket, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.updatedAt = Math.max(bucket.updatedAt, now);
    bucket.frames = Math.min(
      this.limits.frameBurst,
      bucket.frames + elapsed * this.limits.framesPerSecond
    );
    bucket.bytes = Math.min(
      this.limits.bytesPerSecond,
      bucket.bytes + elapsed * this.limits.bytesPerSecond
    );
  }

  /** One raw text frame from a socket. */
  handle(socketId: string, raw: string, now: number): Action[] {
    const socket = this.sockets.get(socketId) ?? this.newSocket(now);
    this.sockets.set(socketId, socket);
    socket.lastSeenAt = now;
    socket.missedPings = 0;
    if (typeof raw !== "string" || raw.length > this.limits.maxFrameChars) {
      return [
        { close: socketId, code: CLOSE_TOO_BIG, reason: "frame too large" },
        ...this.leave(socketId, now),
      ];
    }
    this.refill(socket.bucket, now);
    if (socket.bucket.frames < 1 || socket.bucket.bytes < raw.length) {
      return this.strike(socketId, socket, "rate_limited");
    }
    socket.bucket.frames -= 1;
    socket.bucket.bytes -= raw.length;

    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return this.strike(socketId, socket, "bad_request");
    }
    if (!isRecord(frame)) {
      return this.strike(socketId, socket, "bad_request");
    }
    switch (frame.type) {
      case "join":
        return this.join(socketId, socket, frame, now);
      case "data":
        return this.data(socketId, socket, frame);
      case "policy":
        return this.policy(socketId, socket, frame);
      case "kick":
        return this.kick(socketId, socket, frame, now);
      case "ping":
        return [{ to: socketId, frame: { type: "pong" } }];
      case "pong":
        return [];
      default:
        return this.strike(socketId, socket, "bad_request");
    }
  }

  /** Who a joining socket becomes: the creator, a returning host, or a guest. */
  private seat(
    socketId: string,
    presented: string | null,
    create: boolean,
    now: number
  ):
    | { host: boolean; issued: string | undefined; retire: Action[] }
    | { refuse: Action[] } {
    if (
      presented &&
      this.persisted.hostSecret &&
      secretsMatch(presented, this.persisted.hostSecret)
    ) {
      // The same person coming back: retire the seat they left behind.
      const retire: Action[] = [];
      for (const [otherId, other] of this.sockets) {
        if (otherId !== socketId && other.member?.host) {
          retire.push(
            { close: otherId, code: CLOSE_REPLACED, reason: "replaced" },
            ...this.leave(otherId, now)
          );
        }
      }
      return { host: true, issued: undefined, retire };
    }
    if (this.persisted.hostSecret !== null) {
      return { host: false, issued: undefined, retire: [] };
    }
    if (!create) {
      return {
        refuse: [
          { to: socketId, frame: { type: "error", code: "not_found" } },
          { close: socketId, code: CLOSE_NOT_FOUND, reason: "not_found" },
          ...this.leave(socketId, now),
        ],
      };
    }
    const issued = this.random();
    this.persisted.hostSecret = issued;
    this.persisted.createdAt = now;
    return { host: true, issued, retire: [] };
  }

  private join(
    socketId: string,
    socket: Socket,
    frame: Record<string, unknown>,
    now: number
  ): Action[] {
    if (
      socket.member ||
      frame.room !== this.roomId ||
      typeof frame.create !== "boolean" ||
      (frame.hostSecret !== undefined &&
        (typeof frame.hostSecret !== "string" ||
          frame.hostSecret.length > MAX_SECRET))
    ) {
      return this.strike(socketId, socket, "bad_request");
    }
    const seat = this.seat(
      socketId,
      typeof frame.hostSecret === "string" ? frame.hostSecret : null,
      frame.create,
      now
    );
    if ("refuse" in seat) {
      return seat.refuse;
    }
    if (this.members.length >= this.limits.maxMembers) {
      return [
        ...seat.retire,
        { to: socketId, frame: { type: "error", code: "room_full" } },
        { close: socketId, code: CLOSE_FULL, reason: "room_full" },
        ...this.leave(socketId, now),
      ];
    }
    const member: MemberInfo = { id: socketId, host: seat.host, joinedAt: now };
    const others = this.members;
    socket.member = member;
    const wasEmpty = this.persisted.emptySince !== null;
    this.persisted.emptySince = null;
    const actions: Action[] = [
      ...seat.retire,
      {
        to: socketId,
        frame: {
          type: "joined",
          you: socketId,
          host: seat.host,
          ...(seat.issued ? { hostSecret: seat.issued } : {}),
          locked: this.persisted.locked,
          members: others,
        },
      },
      {
        to: "others",
        from: socketId,
        frame: { type: "member-joined", member: { ...member } },
      },
    ];
    if (seat.issued || wasEmpty) {
      actions.push({ persist: this.state }, { deleteAt: null });
    }
    return actions;
  }

  private data(
    socketId: string,
    socket: Socket,
    frame: Record<string, unknown>
  ): Action[] {
    if (!socket.member) {
      return this.strike(socketId, socket, "forbidden");
    }
    if (
      !isChannel(frame.channel) ||
      typeof frame.payload !== "string" ||
      (frame.to !== undefined && !isId(frame.to))
    ) {
      return this.strike(socketId, socket, "bad_request");
    }
    if (
      this.persisted.locked &&
      !socket.member.host &&
      HOST_ONLY_WHEN_LOCKED.includes(frame.channel)
    ) {
      // A guest may race the lock notice; tell it, but do not count a strike.
      return [{ to: socketId, frame: { type: "error", code: "locked" } }];
    }
    const out: ServerFrame = {
      type: "data",
      from: socketId,
      channel: frame.channel,
      payload: frame.payload,
    };
    if (typeof frame.to === "string") {
      const target = this.sockets.get(frame.to);
      if (!target?.member || frame.to === socketId) {
        // The recipient just left (or the sender addressed itself): drop quietly.
        return [];
      }
      return [{ to: frame.to, frame: out }];
    }
    return [{ to: "others", from: socketId, frame: out }];
  }

  private policy(
    socketId: string,
    socket: Socket,
    frame: Record<string, unknown>
  ): Action[] {
    if (!socket.member?.host) {
      return this.strike(socketId, socket, "forbidden");
    }
    if (typeof frame.locked !== "boolean") {
      return this.strike(socketId, socket, "bad_request");
    }
    this.persisted.locked = frame.locked;
    return [
      { to: "all", frame: { type: "policy", locked: frame.locked } },
      { persist: this.state },
    ];
  }

  private kick(
    socketId: string,
    socket: Socket,
    frame: Record<string, unknown>,
    now: number
  ): Action[] {
    if (!socket.member?.host) {
      return this.strike(socketId, socket, "forbidden");
    }
    if (!isId(frame.id) || frame.id === socketId) {
      return this.strike(socketId, socket, "bad_request");
    }
    const target = this.sockets.get(frame.id);
    if (!target?.member) {
      return [];
    }
    return [
      { close: frame.id, code: CLOSE_KICKED, reason: "kicked" },
      ...this.leave(frame.id, now),
    ];
  }

  /** A socket went away (closed, errored, or was closed by an action). */
  leave(socketId: string, now: number): Action[] {
    const socket = this.sockets.get(socketId);
    if (!socket) {
      return [];
    }
    this.sockets.delete(socketId);
    if (!socket.member) {
      return [];
    }
    const actions: Action[] = [
      { to: "all", frame: { type: "member-left", id: socketId } },
    ];
    if (this.members.length === 0) {
      this.persisted.emptySince = now;
      actions.push(
        { persist: this.state },
        { deleteAt: now + this.limits.expireAfterMs }
      );
    }
    return actions;
  }

  /** Periodic housekeeping: pings, idle drops, join timeouts, expiry. */
  tick(now: number): Action[] {
    const actions: Action[] = [];
    for (const [socketId, socket] of [...this.sockets]) {
      if (!socket.member) {
        if (now - socket.attachedAt >= this.limits.joinTimeoutMs) {
          actions.push({
            close: socketId,
            code: CLOSE_JOIN_TIMEOUT,
            reason: "join timeout",
          });
          this.sockets.delete(socketId);
        }
        continue;
      }
      if (now - socket.lastSeenAt < this.limits.pingAfterMs) {
        continue;
      }
      if (socket.missedPings >= this.limits.dropAfterMissedPings) {
        actions.push(
          { close: socketId, code: CLOSE_IDLE, reason: "idle" },
          ...this.leave(socketId, now)
        );
        continue;
      }
      if (now - socket.lastPingAt >= this.limits.pingAfterMs) {
        socket.lastPingAt = now;
        socket.missedPings += 1;
        actions.push({ to: socketId, frame: { type: "ping" } });
      }
    }
    if (
      this.members.length === 0 &&
      this.persisted.emptySince !== null &&
      now - this.persisted.emptySince >= this.limits.expireAfterMs
    ) {
      this.persisted = {
        createdAt: null,
        emptySince: null,
        hostSecret: null,
        locked: false,
      };
      actions.push({ expire: true });
    }
    return actions;
  }
}

function stripUndefined(options: HubOptions): Partial<Limits> {
  const out: Partial<Limits> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key !== "random" && typeof value === "number") {
      (out as Record<string, number>)[key] = value;
    }
  }
  return out;
}
