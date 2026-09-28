/**
 * The per-book reading session: annotations and the saved position live in
 * Yjs + IndexedDB on this device; a room (see `@/lib/rooms`) optionally
 * connects several readers of the same EPUB so notes and positions travel
 * between them.
 *
 * Wire, on top of the room's sealed channels:
 *
 *   presence  JSON  hello { name, color, fingerprint, title, readerId, v:1 }
 *                   location { locator }   ·   bye
 *   control   bytes chunk frames of type 3: a Yjs state vector (sync step 1,
 *                   "what do you have?"); allowed for every reader
 *   notes     bytes chunk frames of type 1: a Yjs update (step 2 answers and
 *                   live changes); refused by the relay for guests of a
 *                   locked room
 *
 * Roles: the host can lock the room; while locked the relay refuses guests'
 * `notes` frames and every reader also ignores non-host updates, so the host
 * never has to trust a guest's claim about its own permissions.
 */
import { IndexeddbPersistence } from "y-indexeddb";
import {
  applyUpdate,
  Doc,
  decodeStateVector,
  encodeStateAsUpdate,
  encodeStateVector,
} from "yjs";
import {
  createRoom,
  decodeJson,
  defaultJoinOrigin,
  joinRoom,
  normalizeRoomCode,
  type RoomClient,
  RoomError,
  type RoomEvent,
  type RoomMember,
  type RoomTransport,
  roomJoinUrl,
} from "@/lib/rooms";
import {
  colorForReader,
  localReaderId,
  rememberReaderName,
  storedReaderName,
} from "./presence";
import {
  applyPeerUpdate,
  encodeChunks,
  invalid,
  MAX_STATE_VECTOR_BYTES,
  MessageBudget,
  NOTES_STATE,
  NOTES_UPDATE,
  parsePresenceFrame,
  readAnnotations,
  type ShareRole,
  UpdateAssembler,
  validateAnnotation,
  validateLocator,
  validateUpdateComplexity,
} from "./protocol";
import type { Annotation, ContentLocator } from "./types";

export type { ShareRole } from "./protocol";

export interface MemberView {
  color: string;
  id: string;
  isHost: boolean;
  isMe: boolean;
  lastSeenAt: number;
  location: ContentLocator | null;
  name: string;
}

export interface RoomView {
  bookTitle: string;
  code: string;
  locked: boolean;
  members: MemberView[];
  role: "guest" | "host";
  status: string;
  url: string;
}

export interface HostOptions {
  bookTitle: string;
  guestsCanAnnotate: boolean;
  name: string;
  relayUrl: string;
}

export interface JoinOptions {
  name: string;
  relayUrl: string;
}

export interface ReadingSession {
  /** @deprecated Pairing codes were replaced by rooms; rejects with guidance. */
  acceptAnswer(code: string): Promise<void>;
  /** @deprecated Pairing codes were replaced by rooms; rejects with guidance. */
  acceptOffer(code: string): Promise<string>;
  add(kind: Annotation["kind"], locator: ContentLocator, text?: string): void;
  readonly annotations: Annotation[];
  readonly annotationVersion: number;
  /** False for a guest while the host has locked the room. */
  readonly canAnnotate: boolean;
  /** @deprecated Pairing codes were replaced by rooms; rejects with guidance. */
  createOffer(role: ShareRole): Promise<string>;
  destroy(): Promise<void>;
  /** @deprecated Use `leave()`. */
  disconnect(): void;
  /** @deprecated Rooms have no fingerprints to compare; always empty. */
  readonly fingerprints: string;
  host(options: HostOptions): Promise<RoomView>;
  join(code: string, options: JoinOptions): Promise<RoomView>;
  kick(memberId: string): void;
  readonly lastError: string;
  leave(): void;
  /** @deprecated The room code; see `room.code`. */
  readonly pairingCode: string;
  /** This browser's author id, as stamped on notes it creates. */
  readonly readerId: string;
  /** @deprecated The host's position (or the first other reader's); see `room.members`. */
  readonly remoteLocation: ContentLocator | null;
  remove(id: string): void;
  /** @deprecated `canAnnotate` as the old grant vocabulary. */
  readonly role: ShareRole;
  readonly room: RoomView | null;
  readonly savedLocation: ContentLocator | null;
  saveLocation(locator: ContentLocator): void;
  setGuestsCanAnnotate(allowed: boolean): void;
  readonly status: string;
}

export interface SessionOptions {
  /** Override the IndexedDB database name (tests keep several sessions apart). */
  storageName?: string;
  transport?: RoomTransport;
}

export interface RoomPeek {
  bookTitle: string;
  fingerprint: string;
  hostName: string;
  members: number;
}

const NETWORK_ORIGIN = Symbol("peer");
const LOCAL_ORIGIN = Symbol("local");
const STORAGE_TIMEOUT_MS = 15_000;
const HELLO_WAIT_MS = 8000;
const LOCATION_THROTTLE_MS = 200;
const MAX_INVALID_PER_MEMBER = 5;
const OFFLINE_STATUS = "Offline · saved on this device";
const STORAGE_FAILED_STATUS =
  "Local storage failed · changes may not survive closing";
const STORAGE_FAILED_ERROR =
  "Reading data could not be saved. Free device storage and reopen the book before adding more notes.";
const BOOK_FINGERPRINT = /^[0-9a-f]{64}$/u;

interface MemberState {
  color: string;
  fingerprint: string | null;
  invalid: number;
  isHost: boolean;
  joinedAt: number;
  lastSeenAt: number;
  location: ContentLocator | null;
  name: string;
  readerId: string | null;
  title: string;
}

interface Inbox {
  budget: MessageBudget;
  state: UpdateAssembler;
  update: UpdateAssembler;
}

function errorOf(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeout: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function placeholder(member: RoomMember, now: number): MemberState {
  return {
    color: colorForReader(member.id),
    fingerprint: null,
    invalid: 0,
    isHost: member.isHost,
    joinedAt: member.joinedAt,
    lastSeenAt: now,
    location: null,
    name: member.isHost ? "Host" : "Reader",
    readerId: null,
    title: "",
  };
}

class Session implements ReadingSession {
  private readonly doc: Doc;
  private readonly persistence: IndexeddbPersistence;
  private readonly chapterIds: ReadonlySet<string>;
  private readonly fingerprint: string;
  private readonly changed: () => void;
  private readonly failed: (error: Error) => void;
  private readonly transport: RoomTransport | undefined;
  private notes: Annotation[] = [];
  private notesVersion = 0;
  private localPosition: ContentLocator | null = null;
  private persistentError = "";
  private destroyed = false;
  private storageFailed = false;
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private locationTimer: ReturnType<typeof setTimeout> | undefined;

  // Identity
  readonly readerId = localReaderId();
  private displayName = storedReaderName() ?? "Reader";

  // Room
  private client: RoomClient | null = null;
  private code = "";
  private roleValue: "guest" | "host" = "guest";
  private lockedValue = false;
  private title = "";
  private roomStatus = "";
  private readonly members = new Map<string, MemberState>();
  private readonly inboxes = new Map<string, Inbox>();
  private transferId = 0;
  private hostHello: {
    reject: (error: Error) => void;
    resolve: () => void;
  } | null = null;

  constructor(
    fingerprint: string,
    chapterIds: ReadonlySet<string>,
    doc: Doc,
    persistence: IndexeddbPersistence,
    onChange: () => void,
    onError: (error: Error) => void,
    savedLocation: ContentLocator | null,
    transport: RoomTransport | undefined
  ) {
    this.fingerprint = fingerprint;
    this.chapterIds = chapterIds;
    this.doc = doc;
    this.persistence = persistence;
    this.changed = onChange;
    this.failed = onError;
    this.localPosition = savedLocation;
    this.transport = transport;
    this.notes = readAnnotations(doc, chapterIds);
    doc.on("update", this.documentChanged);
  }

  // ----- local state ---------------------------------------------------------

  get annotations(): Annotation[] {
    return structuredClone(this.notes);
  }
  get annotationVersion(): number {
    return this.notesVersion;
  }
  get savedLocation(): ContentLocator | null {
    return this.localPosition ? structuredClone(this.localPosition) : null;
  }
  get lastError(): string {
    return this.persistentError;
  }
  get canAnnotate(): boolean {
    if (this.destroyed || this.storageFailed) {
      return false;
    }
    return !this.client || this.roleValue === "host" || !this.lockedValue;
  }
  get status(): string {
    const base = this.client ? this.roomStatus : this.baseStatus();
    if (this.pendingWrites.size === 0 || this.storageFailed) {
      return base;
    }
    return base === OFFLINE_STATUS
      ? "Offline · saving on this device…"
      : `${base} · saving locally…`;
  }

  private baseStatus(): string {
    return this.storageFailed ? STORAGE_FAILED_STATUS : OFFLINE_STATUS;
  }

  private notify(): void {
    if (!this.destroyed) {
      this.changed();
    }
  }

  private storageWrite(promise: Promise<unknown>): void {
    const tracked = promise
      .catch(() => {
        if (!this.storageFailed) {
          this.storageFailed = true;
          this.leave();
          this.persistentError = STORAGE_FAILED_ERROR;
          this.failed(new Error(this.persistentError));
          this.notify();
        }
      })
      .finally(() => {
        this.pendingWrites.delete(tracked);
        this.notify();
      });
    this.pendingWrites.add(tracked);
  }

  private readonly documentChanged = (
    update: Uint8Array,
    origin: unknown
  ): void => {
    this.notes = readAnnotations(this.doc, this.chapterIds);
    this.notesVersion += 1;
    // y-indexeddb persists the update stream. An awaited checkpoint additionally surfaces quota errors.
    this.storageWrite(
      this.persistence.set(
        "checkpoint",
        new Uint8Array(encodeStateAsUpdate(this.doc)).buffer
      )
    );
    if (origin !== NETWORK_ORIGIN && this.client?.state === "open") {
      this.broadcastUpdate(update);
    }
    this.notify();
  };

  private requireEditing(): void {
    if (this.destroyed) {
      throw new Error("This book is closed.");
    }
    if (this.storageFailed) {
      throw new Error(
        "Local storage is unavailable. Reopen the book before editing."
      );
    }
    if (!this.canAnnotate) {
      throw new Error(
        "The host has locked this room, so guests can read notes but not add their own. Leave the room to keep private notes."
      );
    }
  }

  add(kind: Annotation["kind"], locator: ContentLocator, text = ""): void {
    this.requireEditing();
    const note = validateAnnotation(
      {
        id: crypto.randomUUID(),
        kind,
        locator,
        text,
        createdAt: Date.now(),
        author: {
          id: this.readerId,
          name: this.displayName,
          color: colorForReader(this.readerId),
        },
      },
      this.chapterIds
    );
    const candidate = new Doc();
    try {
      applyUpdate(candidate, encodeStateAsUpdate(this.doc));
      candidate.getMap("annotations").set(note.id, note);
      readAnnotations(candidate, this.chapterIds);
      validateUpdateComplexity(encodeStateAsUpdate(candidate), this.chapterIds);
      this.doc.transact(
        () => this.doc.getMap("annotations").set(note.id, note),
        LOCAL_ORIGIN
      );
    } finally {
      candidate.destroy();
    }
  }

  remove(id: string): void {
    this.requireEditing();
    if (!this.doc.getMap("annotations").has(id)) {
      throw new Error("This note was already removed on another device.");
    }
    this.doc.transact(
      () => this.doc.getMap("annotations").delete(id),
      LOCAL_ORIGIN
    );
  }

  saveLocation(locator: ContentLocator): void {
    if (this.destroyed) {
      return;
    }
    if (this.storageFailed) {
      throw new Error(
        "Local storage is unavailable. Reopen the book before saving a reading position."
      );
    }
    const position = validateLocator(locator, this.chapterIds);
    if (JSON.stringify(position) === JSON.stringify(this.localPosition)) {
      return;
    }
    this.localPosition = position;
    this.storageWrite(
      this.persistence.set("local-location", JSON.stringify(position))
    );
    this.notify();
    // Coalesce rapid navigation into one presence update; there is no timer while idle.
    clearTimeout(this.locationTimer);
    this.locationTimer = setTimeout(() => {
      this.locationTimer = undefined;
      if (this.client?.state === "open" && this.localPosition) {
        this.sendPresence({ t: "location", locator: this.localPosition });
      }
    }, LOCATION_THROTTLE_MS);
  }

  // ----- room views ------------------------------------------------------------

  get room(): RoomView | null {
    if (!(this.client && this.code)) {
      return null;
    }
    return {
      code: this.code,
      url: roomJoinUrl(this.code, defaultJoinOrigin()),
      role: this.roleValue,
      locked: this.lockedValue,
      members: this.memberViews(),
      status: this.roomStatus,
      bookTitle: this.title,
    };
  }

  private memberViews(): MemberView[] {
    const me: MemberView = {
      id: this.client?.id ?? "",
      name: this.displayName,
      color: colorForReader(this.readerId),
      isHost: this.roleValue === "host",
      isMe: true,
      location: this.savedLocation,
      lastSeenAt: Date.now(),
    };
    const others = [...this.members.entries()]
      .sort((a, b) => a[1].joinedAt - b[1].joinedAt)
      .map(
        ([id, member]): MemberView => ({
          id,
          name: member.name,
          color: member.color,
          isHost: member.isHost,
          isMe: false,
          location: member.location ? structuredClone(member.location) : null,
          lastSeenAt: member.lastSeenAt,
        })
      );
    return [me, ...others];
  }

  private describeRoom(): string {
    const count = this.members.size;
    if (this.roleValue === "host") {
      return count === 0
        ? "Hosting · waiting for readers"
        : `Hosting · ${count} ${count === 1 ? "reader" : "readers"} with you`;
    }
    const host = [...this.members.values()].find((member) => member.isHost);
    const label = host ? `Reading with ${host.name}` : "Reading together";
    return this.lockedValue ? `${label} · read-only` : label;
  }

  private refreshStatus(): void {
    this.roomStatus = this.describeRoom();
    this.notify();
  }

  // ----- hosting and joining ---------------------------------------------------

  async host(options: HostOptions): Promise<RoomView> {
    this.requireOpen();
    this.leave();
    this.displayName = rememberReaderName(options.name);
    this.title = options.bookTitle.slice(0, 400);
    this.roleValue = "host";
    this.lockedValue = !options.guestsCanAnnotate;
    this.roomStatus = "Opening a room…";
    this.notify();
    const buffered: RoomEvent[] = [];
    let ready = false;
    const listener = (event: RoomEvent) => {
      if (ready) {
        this.onRoomEvent(event);
      } else {
        buffered.push(event);
      }
    };
    try {
      const { client, code } = await createRoom({
        relayUrl: options.relayUrl,
        transport: this.transport,
        listener,
      });
      if (!client.isHost) {
        client.close();
        throw new RoomError(
          "exists",
          "That room already has a host. Try creating a new room."
        );
      }
      this.client = client;
      this.code = code;
      client.setLocked(this.lockedValue);
      ready = true;
      for (const event of buffered) {
        this.onRoomEvent(event);
      }
    } catch (error) {
      this.leave();
      throw errorOf(error, "The room could not be opened.");
    }
    this.refreshStatus();
    return this.room as RoomView;
  }

  async join(code: string, options: JoinOptions): Promise<RoomView> {
    this.requireOpen();
    const normalized = normalizeRoomCode(code);
    if (!normalized) {
      throw new RoomError(
        "bad_code",
        "That doesn't look like a room code. Codes look like ABCD-EFGH-JKLM."
      );
    }
    this.leave();
    this.displayName = rememberReaderName(options.name);
    this.roleValue = "guest";
    this.roomStatus = "Joining the room…";
    this.notify();
    const buffered: RoomEvent[] = [];
    let ready = false;
    const listener = (event: RoomEvent) => {
      if (ready) {
        this.onRoomEvent(event);
      } else {
        buffered.push(event);
      }
    };
    try {
      const client = await joinRoom({
        code: normalized,
        relayUrl: options.relayUrl,
        transport: this.transport,
        listener,
      });
      this.client = client;
      this.code = normalized;
      const hello = this.expectHostHello();
      ready = true;
      for (const event of buffered) {
        this.onRoomEvent(event);
      }
      await hello;
    } catch (error) {
      this.leave();
      throw errorOf(error, "The room could not be joined.");
    }
    this.refreshStatus();
    return this.room as RoomView;
  }

  /**
   * Resolves once the host has introduced itself (or at once when no host is
   * present); rejects when the host is reading a different EPUB.
   */
  private expectHostHello(): Promise<void> {
    const client = this.client;
    if (!client?.members.some((member) => member.isHost)) {
      return Promise.resolve();
    }
    return withDeadline(
      new Promise<void>((resolve, reject) => {
        this.hostHello = { resolve, reject };
      }),
      HELLO_WAIT_MS,
      "The host did not respond. Ask them to reopen the room."
    ).finally(() => {
      this.hostHello = null;
    });
  }

  private requireOpen(): void {
    if (this.destroyed) {
      throw new Error("This book is closed.");
    }
    if (this.storageFailed) {
      throw new Error(
        "Local storage is unavailable. Reopen the book before joining a room."
      );
    }
  }

  leave(): void {
    const client = this.client;
    this.client = null;
    if (client) {
      if (client.state === "open") {
        try {
          client.send("presence", { t: "bye" });
        } catch {
          // The socket is already gone.
        }
      }
      client.close();
    }
    this.hostHello?.reject(new Error("Left the room."));
    this.hostHello = null;
    this.code = "";
    this.members.clear();
    this.inboxes.clear();
    this.lockedValue = false;
    this.roleValue = "guest";
    this.title = "";
    this.roomStatus = "";
    this.notify();
  }

  setGuestsCanAnnotate(allowed: boolean): void {
    if (!(this.client && this.roleValue === "host")) {
      throw new Error("Only the host can change who may annotate.");
    }
    this.lockedValue = !allowed;
    this.client.setLocked(!allowed);
    if (allowed) {
      // Guests may now share what they wrote while locked: ask again.
      this.sendStateVector();
    }
    this.refreshStatus();
  }

  kick(memberId: string): void {
    if (!(this.client && this.roleValue === "host")) {
      throw new Error("Only the host can remove readers.");
    }
    this.client.kick(memberId);
  }

  // ----- room events -----------------------------------------------------------

  private onRoomEvent(event: RoomEvent): void {
    switch (event.type) {
      case "open":
        this.roomOpened(event.members, event.locked);
        return;
      case "member-joined":
        this.members.set(
          event.member.id,
          placeholder(event.member, Date.now())
        );
        this.inboxes.delete(event.member.id);
        this.sendHello(event.member.id);
        this.sendStateVector(event.member.id);
        this.refreshStatus();
        return;
      case "member-left":
        this.members.delete(event.id);
        this.inboxes.delete(event.id);
        this.refreshStatus();
        return;
      case "message":
        this.receive(event);
        return;
      case "policy": {
        const unlocked = this.lockedValue && !event.locked;
        this.lockedValue = event.locked;
        if (unlocked) {
          this.sendStateVector();
        }
        this.refreshStatus();
        return;
      }
      case "reconnecting":
        this.roomStatus = "Reconnecting to the room…";
        this.notify();
        return;
      case "closed":
        this.roomClosed(event.code, event.reason);
        return;
      default:
        return;
    }
  }

  private roomOpened(members: RoomMember[], locked: boolean): void {
    const now = Date.now();
    this.members.clear();
    this.inboxes.clear();
    for (const member of members) {
      this.members.set(member.id, placeholder(member, now));
    }
    if (this.roleValue !== "host") {
      this.lockedValue = locked;
    }
    this.sendHello();
    this.sendStateVector();
    if (this.localPosition) {
      this.sendPresence({ t: "location", locator: this.localPosition });
    }
    this.refreshStatus();
  }

  private roomClosed(code: string, reason: string): void {
    if (!this.client) {
      return;
    }
    this.client = null;
    this.code = "";
    this.members.clear();
    this.inboxes.clear();
    this.roomStatus = "";
    if (code !== "closed") {
      this.persistentError = reason;
      this.failed(new RoomError(code as RoomError["code"], reason));
    }
    this.notify();
  }

  // ----- sending -----------------------------------------------------------------

  private sendPresence(frame: object, to?: string): void {
    const client = this.client;
    if (!client || client.state !== "open") {
      return;
    }
    try {
      client.send("presence", frame, to);
    } catch (error) {
      this.failed(errorOf(error, "A presence update could not be sent."));
    }
  }

  private sendHello(to?: string): void {
    this.sendPresence(
      {
        t: "hello",
        v: 1,
        name: this.displayName,
        color: colorForReader(this.readerId),
        fingerprint: this.fingerprint,
        title: this.title,
        readerId: this.readerId,
      },
      to
    );
  }

  private nextTransferId(): number {
    this.transferId = (this.transferId + 1) % 0x1_00_00_00_00;
    return this.transferId;
  }

  private sendChunks(
    channel: "control" | "notes",
    bytes: Uint8Array,
    frameType: number,
    to?: string
  ): void {
    const client = this.client;
    if (!client || client.state !== "open") {
      return;
    }
    try {
      for (const frame of encodeChunks(
        bytes,
        this.nextTransferId(),
        frameType
      )) {
        client.send(channel, new Uint8Array(frame), to);
      }
    } catch (error) {
      this.failed(errorOf(error, "Notes could not be sent to the room."));
    }
  }

  /** Sync step 1: ask a reader (or everyone) what they hold. */
  private sendStateVector(to?: string): void {
    this.sendChunks("control", encodeStateVector(this.doc), NOTES_STATE, to);
  }

  private sendUpdate(update: Uint8Array, to?: string): void {
    this.sendChunks("notes", update, NOTES_UPDATE, to);
  }

  private broadcastUpdate(update: Uint8Array): void {
    if (!this.canAnnotate) {
      return;
    }
    this.sendUpdate(update);
  }

  // ----- receiving -----------------------------------------------------------------

  private inbox(from: string): Inbox {
    let inbox = this.inboxes.get(from);
    if (!inbox) {
      inbox = {
        budget: new MessageBudget(),
        state: new UpdateAssembler(NOTES_STATE, MAX_STATE_VECTOR_BYTES),
        update: new UpdateAssembler(NOTES_UPDATE),
      };
      this.inboxes.set(from, inbox);
    }
    return inbox;
  }

  private receive(event: Extract<RoomEvent, { type: "message" }>): void {
    const member = this.members.get(event.from);
    if (!member) {
      return;
    }
    member.lastSeenAt = Date.now();
    try {
      if (event.channel === "presence") {
        if (event.kind !== "json") {
          throw invalid();
        }
        this.receivePresence(event.from, member, decodeJson(event.data));
      } else if (event.channel === "control") {
        if (event.kind !== "bytes") {
          throw invalid();
        }
        this.receiveStateVector(event.from, event.data);
      } else if (event.channel === "notes") {
        if (event.kind !== "bytes") {
          throw invalid();
        }
        this.receiveUpdate(event.from, member, event.data);
      }
    } catch (error) {
      member.invalid += 1;
      if (member.invalid <= MAX_INVALID_PER_MEMBER) {
        this.failed(
          errorOf(
            error,
            `${member.name} sent reading data Leaflet could not use.`
          )
        );
      }
    }
  }

  private receivePresence(
    from: string,
    member: MemberState,
    value: unknown
  ): void {
    const frame = parsePresenceFrame(value, this.chapterIds);
    if (frame.t === "hello") {
      member.name = frame.name;
      member.color = frame.color;
      member.readerId = frame.readerId;
      member.fingerprint = frame.fingerprint;
      member.title = frame.title;
      if (member.isHost && this.roleValue === "guest") {
        if (frame.fingerprint !== this.fingerprint) {
          const error = new RoomError(
            "bad_code",
            `This room is reading “${frame.title || "another book"}”. Open the same EPUB file to join.`
          );
          this.hostHello?.reject(error);
          if (!this.hostHello) {
            this.persistentError = error.message;
            this.failed(error);
            this.leave();
          }
          return;
        }
        this.title = frame.title;
        this.hostHello?.resolve();
      }
      this.refreshStatus();
      return;
    }
    if (frame.t === "location") {
      member.location = frame.locator;
      this.notify();
      return;
    }
    // bye: the relay's member-left follows.
    this.members.delete(from);
    this.inboxes.delete(from);
    this.refreshStatus();
  }

  /** Updates count only when the room policy lets that reader write. */
  private accepts(member: MemberState): boolean {
    if (
      member.fingerprint !== null &&
      member.fingerprint !== this.fingerprint
    ) {
      return false;
    }
    return member.isHost || !this.lockedValue;
  }

  /** Sync step 1 from a reader: answer with what they are missing, if we may share. */
  private receiveStateVector(from: string, data: Uint8Array): void {
    const inbox = this.inbox(from);
    const vector = inbox.state.receive(data.slice().buffer, true);
    if (!vector) {
      return;
    }
    inbox.budget.consume();
    decodeStateVector(vector);
    if (this.canAnnotate) {
      this.sendUpdate(encodeStateAsUpdate(this.doc, vector), from);
    }
  }

  private receiveUpdate(
    from: string,
    member: MemberState,
    data: Uint8Array
  ): void {
    const inbox = this.inbox(from);
    const allowed = this.accepts(member);
    const update = inbox.update.receive(data.slice().buffer, allowed);
    if (!update) {
      return;
    }
    inbox.budget.consume();
    applyPeerUpdate(this.doc, update, allowed, this.chapterIds, NETWORK_ORIGIN);
  }

  // ----- deprecated pairing surface ------------------------------------------------

  get role(): ShareRole {
    return this.canAnnotate ? "annotate" : "read";
  }
  get pairingCode(): string {
    return this.code;
  }
  get fingerprints(): string {
    return "";
  }
  get remoteLocation(): ContentLocator | null {
    const sorted = [...this.members.values()].sort(
      (a, b) => Number(b.isHost) - Number(a.isHost)
    );
    const found = sorted.find((member) => member.location);
    return found?.location ? structuredClone(found.location) : null;
  }
  createOffer(): Promise<string> {
    return Promise.reject(
      new Error(
        "Pairing codes were replaced by room codes. Use host() instead."
      )
    );
  }
  acceptOffer(): Promise<string> {
    return Promise.reject(
      new Error(
        "Pairing codes were replaced by room codes. Use join() instead."
      )
    );
  }
  acceptAnswer(): Promise<void> {
    return Promise.reject(
      new Error(
        "Pairing codes were replaced by room codes. Use join() instead."
      )
    );
  }
  disconnect(): void {
    this.leave();
  }

  // ----- teardown --------------------------------------------------------------------

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.leave();
    this.destroyed = true;
    clearTimeout(this.locationTimer);
    this.doc.off("update", this.documentChanged);
    // Complete local writes before closing the provider; networking has already stopped.
    try {
      await Promise.allSettled([...this.pendingWrites]);
      await this.persistence.destroy();
      this.doc.destroy();
    } catch {
      this.failed(
        new Error(
          "Reading storage could not close cleanly. Reopen the book to verify saved notes."
        )
      );
    }
  }
}

export async function createReadingSession(
  fingerprint: string,
  chapterIds: string[],
  onChange: () => void,
  onError: (error: Error) => void,
  options: SessionOptions = {}
): Promise<ReadingSession> {
  if (
    !(BOOK_FINGERPRINT.test(fingerprint) && Array.isArray(chapterIds)) ||
    chapterIds.length === 0 ||
    chapterIds.some((id) => typeof id !== "string" || !id)
  ) {
    throw new Error("This book has no stable reading identity.");
  }
  if (typeof indexedDB === "undefined") {
    throw new Error("This browser cannot persist reading notes.");
  }
  const doc = new Doc();
  doc.getMap("annotations");
  const persistence = new IndexeddbPersistence(
    options.storageName ?? `leaflet-reading-v1-${fingerprint}`,
    doc
  );
  try {
    // get() propagates an open failure; whenSynced alone has no rejection path in y-indexeddb.
    const [checkpoint, storedLocation] = await withDeadline(
      Promise.all([
        persistence.get("checkpoint"),
        persistence.get("local-location"),
        persistence.whenSynced,
      ]),
      STORAGE_TIMEOUT_MS,
      "Local reading storage did not become ready. Reopen the book and check device storage."
    );
    const allowedChapters = new Set(chapterIds);
    readAnnotations(doc, allowedChapters);
    if (checkpoint !== undefined) {
      // IndexedDB can return an ArrayBuffer from another realm (for example,
      // a webview bridge). The tag is checked as well as the local prototype.
      if (
        !(checkpoint instanceof ArrayBuffer) &&
        Object.prototype.toString.call(checkpoint) !== "[object ArrayBuffer]"
      ) {
        throw new Error("The stored reading checkpoint is invalid.");
      }
      applyPeerUpdate(
        doc,
        new Uint8Array(checkpoint),
        true,
        allowedChapters,
        persistence
      );
    }
    if (storedLocation !== undefined && typeof storedLocation !== "string") {
      throw new Error("The stored reading position is invalid.");
    }
    const location =
      storedLocation === undefined
        ? null
        : validateLocator(
            JSON.parse(storedLocation as string),
            allowedChapters
          );
    return new Session(
      fingerprint,
      allowedChapters,
      doc,
      persistence,
      onChange,
      onError,
      location,
      options.transport
    );
  } catch (error) {
    // Preserve the actionable readiness/corruption failure if best-effort provider cleanup also fails.
    persistence.destroy().catch(() => undefined);
    doc.destroy();
    throw errorOf(error, "Local reading storage could not be opened.");
  }
}

/**
 * Look into a room without taking part: join, wait for the host's greeting,
 * leave. Lets the app open the right book before a real join.
 */
interface PeekWatch {
  fail: ((error: Error) => void) | null;
  fallback: RoomPeek | null;
  members: Map<string, RoomMember>;
  settle: ((peek: RoomPeek) => void) | null;
}

function peekHello(
  watch: PeekWatch,
  event: Extract<RoomEvent, { type: "message" }>
): void {
  if (event.channel !== "presence" || event.kind !== "json") {
    return;
  }
  let frame: ReturnType<typeof parsePresenceFrame>;
  try {
    frame = parsePresenceFrame(decodeJson(event.data), new Set<string>());
  } catch {
    return;
  }
  if (frame.t !== "hello") {
    return;
  }
  const peek: RoomPeek = {
    bookTitle: frame.title,
    fingerprint: frame.fingerprint,
    hostName: frame.name,
    members: watch.members.size,
  };
  if (watch.members.get(event.from)?.isHost) {
    watch.settle?.(peek);
  } else {
    watch.fallback ??= peek;
  }
}

function peekListener(watch: PeekWatch): (event: RoomEvent) => void {
  return (event) => {
    switch (event.type) {
      case "open":
        for (const member of event.members) {
          watch.members.set(member.id, member);
        }
        return;
      case "member-joined":
        watch.members.set(event.member.id, event.member);
        return;
      case "closed":
        watch.fail?.(
          new RoomError(event.code as RoomError["code"], event.reason)
        );
        return;
      case "message":
        peekHello(watch, event);
        return;
      default:
        return;
    }
  };
}

/**
 * Look into a room without taking part: join, wait for the host's greeting,
 * leave. Lets the app open the right book before a real join.
 */
export async function peekRoom(
  code: string,
  relayUrl: string,
  options: { timeoutMs?: number; transport?: RoomTransport } = {}
): Promise<RoomPeek> {
  const normalized = normalizeRoomCode(code);
  if (!normalized) {
    throw new RoomError(
      "bad_code",
      "That doesn't look like a room code. Codes look like ABCD-EFGH-JKLM."
    );
  }
  const watch: PeekWatch = {
    fallback: null,
    fail: null,
    members: new Map(),
    settle: null,
  };
  const client = await joinRoom({
    code: normalized,
    relayUrl,
    transport: options.transport,
    listener: peekListener(watch),
  });
  try {
    if (!client.members.length) {
      throw new RoomError(
        "empty",
        "Nobody is in that room right now. Ask the host to open it."
      );
    }
    return await withDeadline(
      new Promise<RoomPeek>((resolve, reject) => {
        watch.settle = resolve;
        watch.fail = reject;
      }),
      options.timeoutMs ?? HELLO_WAIT_MS,
      "The host did not respond in time."
    ).catch((error: unknown) => {
      if (watch.fallback && !(error instanceof RoomError)) {
        return watch.fallback;
      }
      throw error;
    });
  } finally {
    client.close();
  }
}
