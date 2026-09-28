/**
 * The sync conversation between two devices over one open channel.
 *
 *   hello ⇄ hello            both announce who they are and their SAS
 *   sas-ok ⇄ sas-ok          each user confirmed the digits (auto for relay)
 *   manifest ⇄ manifest      what each side holds, with version stamps
 *   progress / trusted       newer records flow in both directions
 *   book-record              newer metadata for books both sides hold
 *   want-book → book-begin, chunks…, book-end   missing books stream over
 *   requests-done ⇄          no more requests will follow
 *   done ⇄ done              both summaries exchanged; the session is complete
 *
 * Both sides run the same code; nothing here depends on who offered.
 */
import type {
  BookFileRecord,
  BookRecord,
  BookRenderRecord,
  LeafletStore,
} from "@/lib/db/types";
import type { SyncChannel } from "./channel";
import { concatBytes, sha256Hex } from "./encoding";
import { SyncError } from "./errors";
import {
  buildManifest,
  type LocalState,
  mergeBookRecord,
  planSync,
} from "./merge";
import {
  CHUNK_SIZE,
  encodeMessage,
  MANIFEST_BATCH,
  type Manifest,
  parseChunk,
  parseMessage,
  RECORD_BATCH,
  type SyncMessage,
} from "./messages";
import type { SyncDevice, SyncEvent, SyncSummary } from "./types";

export type ImportEpubFn = (
  source: Blob,
  fileName: string
) => Promise<{
  book: BookRecord;
  file: BookFileRecord;
  render: BookRenderRecord;
}>;

export interface ProtocolDeps {
  channel: SyncChannel;
  emit: (event: SyncEvent) => void;
  importEpub: ImportEpubFn;
  /** Watchdog: abort when nothing arrives for this long. */
  inactivityMs?: number;
  /** Who the signaling step said is on the other end. */
  peer: SyncDevice;
  sas: string;
  /** Resolves once the user confirmed the SAS (already resolved for relay sessions). */
  sasConfirmed: Promise<void>;
  self: SyncDevice;
  store: LeafletStore;
}

export interface ProtocolResult {
  peer: SyncDevice;
  summary: SyncSummary;
}

export interface ProtocolRun {
  abort(reason: SyncError): void;
  done: Promise<ProtocolResult>;
}

const DEFAULT_INACTIVITY_MS = 60_000;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const READ_WINDOW = 1024 * 1024;
const PROGRESS_EVERY_CHUNKS = 16;

interface IncomingBook {
  chunks: Uint8Array[];
  fileName: string;
  id: string;
  received: number;
  record: BookRecord;
  size: number;
}

function emptySummary(): SyncSummary {
  return {
    booksReceived: 0,
    booksSent: 0,
    progressReceived: 0,
    progressSent: 0,
    trustedReceived: 0,
    trustedSent: 0,
  };
}

const ignore = (): undefined => undefined;

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

export function runSyncProtocol(deps: ProtocolDeps): ProtocolRun {
  const runner = new Runner(deps);
  runner.start();
  return { done: runner.done, abort: (reason) => runner.fail(reason) };
}

class Runner {
  readonly done: Promise<ProtocolResult>;
  private readonly resolveDone: (result: ProtocolResult) => void;
  private readonly rejectDone: (error: SyncError) => void;

  private readonly deps: ProtocolDeps;
  private readonly channel: SyncChannel;
  private queue: Promise<void> = Promise.resolve();
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private verified = false;
  private peerHello = false;
  private peerSasOk = false;
  private sasOkSent = false;

  private local: LocalState | null = null;
  private readonly localLoaded: Promise<void>;
  private readonly resolveLocalLoaded: () => void;
  private peerManifest: Manifest | null = null;
  private peerManifestOpen = false;

  private readonly wanted = new Set<string>();
  private requestsSent = false;
  private peerRequestsDone = false;
  private readonly sendQueue: string[] = [];
  private sending = false;
  private incoming: IncomingBook | null = null;
  private readonly drainWaiters: (() => void)[] = [];

  private readonly summary = emptySummary();
  private doneSent = false;
  private peerDone = false;

  constructor(deps: ProtocolDeps) {
    this.deps = deps;
    this.channel = deps.channel;
    let resolveDone!: (result: ProtocolResult) => void;
    let rejectDone!: (error: SyncError) => void;
    this.done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.resolveDone = resolveDone;
    this.rejectDone = rejectDone;
    this.done.catch(ignore);
    let resolveLocalLoaded!: () => void;
    this.localLoaded = new Promise((resolve) => {
      resolveLocalLoaded = resolve;
    });
    this.resolveLocalLoaded = resolveLocalLoaded;
  }

  start(): void {
    this.channel.bufferedAmountLowThreshold = LOW_WATER;
    this.channel.onmessage = (data) => this.enqueue(() => this.receive(data));
    this.channel.onbufferedamountlow = () => {
      const waiters = this.drainWaiters.splice(0);
      for (const wake of waiters) {
        wake();
      }
    };
    this.channel.onclose = () =>
      this.fail(
        new SyncError(
          "disconnected",
          "The connection to the other device closed."
        )
      );
    this.channel.onerror = (message) =>
      this.fail(new SyncError("channel_error", message));
    this.resetWatchdog();
    this.deps.sasConfirmed.then(
      () => this.enqueue(() => this.onSasConfirmed()),
      ignore
    );
    this.send({
      t: "hello",
      deviceId: this.deps.self.deviceId,
      name: this.deps.self.name,
      sas: this.deps.sas,
    });
  }

  fail(error: SyncError): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    clearTimeout(this.timer);
    try {
      this.send({ t: "abort", reason: error.message.slice(0, 500) });
    } catch {
      // The channel may already be gone; the rejection below carries the cause.
    }
    for (const wake of this.drainWaiters.splice(0)) {
      wake();
    }
    this.deps.emit({ type: "error", message: error.message });
    this.rejectDone(error);
    this.closeChannel();
  }

  private closeChannel(): void {
    this.channel.onmessage = null;
    this.channel.onclose = null;
    this.channel.onerror = null;
    try {
      this.channel.close();
    } catch {
      // Already closed.
    }
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue
      .then(() => (this.finished ? undefined : task()))
      .catch((error: unknown) => {
        this.fail(
          error instanceof SyncError
            ? error
            : new SyncError(
                "internal",
                error instanceof Error
                  ? error.message
                  : "Sync failed unexpectedly."
              )
        );
      });
  }

  private resetWatchdog(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        this.fail(
          new SyncError("timeout", "The other device stopped responding.")
        ),
      this.deps.inactivityMs ?? DEFAULT_INACTIVITY_MS
    );
  }

  private send(message: SyncMessage): void {
    this.channel.send(encodeMessage(message));
  }

  private status(message: string): void {
    this.deps.emit({ type: "status", message });
  }

  // ----- inbound dispatch -------------------------------------------------

  private async receive(data: string | ArrayBuffer): Promise<void> {
    this.resetWatchdog();
    if (typeof data === "string") {
      await this.handle(parseMessage(data));
      return;
    }
    this.handleChunk(data);
  }

  private async handle(message: SyncMessage): Promise<void> {
    if (message.t === "abort") {
      throw new SyncError(
        "peer_aborted",
        message.reason
          ? `The other device stopped: ${message.reason}`
          : "The other device stopped the sync."
      );
    }
    if (message.t === "hello") {
      this.onHello(message);
      return;
    }
    if (message.t === "sas-ok") {
      this.peerSasOk = true;
      await this.checkVerified();
      return;
    }
    if (!this.verified) {
      throw new SyncError("protocol", "The other device skipped verification.");
    }
    switch (message.t) {
      case "manifest-begin":
        this.peerManifest = { books: [], progress: [], trusted: [] };
        this.peerManifestOpen = true;
        return;
      case "manifest-books":
        this.openManifest().books.push(...message.items);
        return;
      case "manifest-progress":
        this.openManifest().progress.push(...message.items);
        return;
      case "manifest-trusted":
        this.openManifest().trusted.push(...message.items);
        return;
      case "manifest-end":
        this.openManifest();
        this.peerManifestOpen = false;
        await this.onPeerManifest();
        return;
      case "progress":
        for (const record of message.items) {
          if (await this.deps.store.putProgress(record)) {
            this.summary.progressReceived += 1;
          }
        }
        return;
      case "trusted":
        for (const record of message.items) {
          if (await this.deps.store.putTrustedOriginRecord(record)) {
            this.summary.trustedReceived += 1;
          }
        }
        return;
      case "book-record":
        await this.onBookRecord(message.record);
        return;
      case "want-book":
        this.sendQueue.push(message.id);
        this.pumpSend();
        return;
      case "requests-done":
        this.peerRequestsDone = true;
        this.maybeFinish();
        return;
      case "book-begin":
        this.onBookBegin(message);
        return;
      case "book-end":
        await this.onBookEnd(message.id);
        return;
      case "book-unavailable":
        this.settleWanted(message.id);
        return;
      case "done":
        this.peerDone = true;
        this.maybeFinish();
        return;
      default:
        throw new SyncError(
          "protocol",
          "Unexpected message from the other device."
        );
    }
  }

  private openManifest(): Manifest {
    if (!(this.peerManifest && this.peerManifestOpen)) {
      throw new SyncError(
        "protocol",
        "The other device sent its library out of order."
      );
    }
    return this.peerManifest;
  }

  // ----- verification -----------------------------------------------------

  private onHello(message: Extract<SyncMessage, { t: "hello" }>): void {
    if (this.peerHello) {
      throw new SyncError(
        "protocol",
        "The other device introduced itself twice."
      );
    }
    if (message.deviceId !== this.deps.peer.deviceId) {
      throw new SyncError(
        "peer_mismatch",
        "The connected device is not the one that produced the pairing code."
      );
    }
    if (message.sas !== this.deps.sas) {
      throw new SyncError(
        "sas_mismatch",
        "The verification codes do not match. Someone may be interfering with the connection."
      );
    }
    this.peerHello = true;
  }

  private async onSasConfirmed(): Promise<void> {
    if (this.sasOkSent) {
      return;
    }
    this.sasOkSent = true;
    this.send({ t: "sas-ok" });
    await this.checkVerified();
  }

  private async checkVerified(): Promise<void> {
    if (
      this.verified ||
      !(this.peerHello && this.peerSasOk && this.sasOkSent)
    ) {
      return;
    }
    this.verified = true;
    this.deps.emit({ type: "connected", peer: this.deps.peer });
    await this.sendManifest();
  }

  // ----- manifests ----------------------------------------------------------

  private async sendManifest(): Promise<void> {
    this.status("Comparing libraries…");
    const store = this.deps.store;
    this.local = {
      books: await store.allBookRecords(),
      progress: await store.allProgress(),
      trusted: await store.allTrustedOriginRecords(),
    };
    this.resolveLocalLoaded();
    const manifest = buildManifest(this.local);
    this.send({ t: "manifest-begin" });
    for (const items of batches(manifest.books, MANIFEST_BATCH)) {
      this.send({ t: "manifest-books", items });
    }
    for (const items of batches(manifest.progress, MANIFEST_BATCH)) {
      this.send({ t: "manifest-progress", items });
    }
    for (const items of batches(manifest.trusted, MANIFEST_BATCH)) {
      this.send({ t: "manifest-trusted", items });
    }
    this.send({ t: "manifest-end" });
  }

  private async onPeerManifest(): Promise<void> {
    await this.localLoaded;
    if (!(this.local && this.peerManifest)) {
      throw new SyncError("protocol", "Library comparison failed.");
    }
    if (this.requestsSent) {
      throw new SyncError(
        "protocol",
        "The other device sent its library twice."
      );
    }
    const plan = planSync(this.local, this.peerManifest);
    const store = this.deps.store;

    for (const { id, deletedAt } of plan.deleteBooks) {
      const current = await store.getBook(id);
      if (current && current.deletedAt === null) {
        await store.deleteBook(id, deletedAt);
      }
    }
    for (const items of batches(plan.sendProgress, RECORD_BATCH)) {
      this.send({ t: "progress", items });
      this.summary.progressSent += items.length;
    }
    for (const items of batches(plan.sendTrusted, RECORD_BATCH)) {
      this.send({ t: "trusted", items });
      this.summary.trustedSent += items.length;
    }
    for (const record of plan.sendBookRecords) {
      this.send({ t: "book-record", record });
    }
    for (const id of plan.wantBooks) {
      this.wanted.add(id);
      this.send({ t: "want-book", id });
    }
    this.send({ t: "requests-done" });
    this.requestsSent = true;
    if (plan.wantBooks.length) {
      this.status(
        `Receiving ${plan.wantBooks.length} ${plan.wantBooks.length === 1 ? "book" : "books"}…`
      );
    }
    this.maybeFinish();
  }

  private async onBookRecord(incoming: BookRecord): Promise<void> {
    const local = await this.deps.store.getBook(incoming.id);
    if (!local) {
      return;
    }
    const merged = mergeBookRecord(local, incoming);
    if (merged) {
      await this.deps.store.putBook(merged);
    }
  }

  // ----- sending books --------------------------------------------------------

  private pumpSend(): void {
    if (this.sending) {
      return;
    }
    this.sending = true;
    this.drainSendQueue();
  }

  /** Never rejects: every failure is routed through `fail`. */
  private async drainSendQueue(): Promise<void> {
    try {
      while (!this.finished && this.sendQueue.length) {
        const id = this.sendQueue.shift() as string;
        await this.sendBook(id);
      }
    } catch (error) {
      this.fail(
        error instanceof SyncError
          ? error
          : new SyncError("send_failed", "Sending a book failed.")
      );
    } finally {
      this.sending = false;
      this.maybeFinish();
    }
  }

  private async sendBook(id: string): Promise<void> {
    const store = this.deps.store;
    const book = await store.getBook(id);
    const file =
      book && book.deletedAt === null ? await store.getBookFile(id) : undefined;
    if (!(book && file)) {
      this.send({ t: "book-unavailable", id });
      return;
    }
    const size = file.blob.size;
    const chunkCount = Math.ceil(size / CHUNK_SIZE);
    const label = book.title || book.fileName;
    this.send({
      t: "book-begin",
      id,
      fileName: book.fileName,
      size,
      chunkCount,
      record: book,
    });
    this.deps.emit({
      type: "transfer",
      direction: "send",
      label,
      done: 0,
      total: size,
    });
    let seq = 0;
    let sent = 0;
    for (let offset = 0; offset < size; offset += READ_WINDOW) {
      const window = new Uint8Array(
        await file.blob
          .slice(offset, Math.min(size, offset + READ_WINDOW))
          .arrayBuffer()
      );
      for (let start = 0; start < window.length; start += CHUNK_SIZE) {
        await this.waitForDrain();
        if (this.finished) {
          return;
        }
        const chunk = window.subarray(
          start,
          Math.min(window.length, start + CHUNK_SIZE)
        );
        this.channel.send(frameChunkBuffer(seq, chunk));
        seq += 1;
        sent += chunk.length;
        if (seq % PROGRESS_EVERY_CHUNKS === 0) {
          this.deps.emit({
            type: "transfer",
            direction: "send",
            label,
            done: sent,
            total: size,
          });
        }
      }
    }
    this.send({ t: "book-end", id });
    this.summary.booksSent += 1;
    this.deps.emit({
      type: "transfer",
      direction: "send",
      label,
      done: size,
      total: size,
    });
  }

  private waitForDrain(): Promise<void> {
    if (this.finished || this.channel.bufferedAmount <= HIGH_WATER) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  // ----- receiving books ------------------------------------------------------

  private onBookBegin(
    message: Extract<SyncMessage, { t: "book-begin" }>
  ): void {
    if (this.incoming) {
      throw new SyncError(
        "protocol",
        "The other device sent two books at once."
      );
    }
    if (!this.wanted.has(message.id)) {
      throw new SyncError(
        "protocol",
        "The other device sent a book that was not requested."
      );
    }
    if (message.record.id !== message.id) {
      throw new SyncError(
        "protocol",
        "The other device sent a mismatched book record."
      );
    }
    this.incoming = {
      id: message.id,
      fileName: message.fileName,
      size: message.size,
      record: message.record,
      chunks: [],
      received: 0,
    };
    this.deps.emit({
      type: "transfer",
      direction: "receive",
      label: message.record.title || message.fileName,
      done: 0,
      total: message.size,
    });
  }

  private handleChunk(buffer: ArrayBuffer): void {
    const incoming = this.incoming;
    if (!incoming) {
      throw new SyncError(
        "protocol",
        "The other device sent data without a book header."
      );
    }
    const { seq, data } = parseChunk(buffer);
    if (seq !== incoming.chunks.length) {
      throw new SyncError(
        "protocol",
        "The other device sent a chunk out of order."
      );
    }
    if (incoming.received + data.length > incoming.size) {
      throw new SyncError(
        "protocol",
        "The other device sent more data than announced."
      );
    }
    incoming.chunks.push(new Uint8Array(data));
    incoming.received += data.length;
    if (incoming.chunks.length % PROGRESS_EVERY_CHUNKS === 0) {
      this.deps.emit({
        type: "transfer",
        direction: "receive",
        label: incoming.record.title || incoming.fileName,
        done: incoming.received,
        total: incoming.size,
      });
    }
  }

  private async onBookEnd(id: string): Promise<void> {
    const incoming = this.incoming;
    if (!incoming || incoming.id !== id) {
      throw new SyncError(
        "protocol",
        "The other device ended a book it never started."
      );
    }
    this.incoming = null;
    const label = incoming.record.title || incoming.fileName;
    if (incoming.received !== incoming.size) {
      throw new SyncError(
        "protocol",
        "The other device sent an incomplete book."
      );
    }
    const bytes = concatBytes(incoming.chunks);
    incoming.chunks.length = 0;
    const digest = await sha256Hex(bytes);
    if (digest !== incoming.id) {
      this.deps.emit({
        type: "error",
        message: `“${label}” arrived corrupted and was discarded.`,
      });
      this.settleWanted(id);
      return;
    }
    const imported = await this.deps.importEpub(
      new Blob([bytes], { type: "application/epub+zip" }),
      incoming.fileName
    );
    if (imported.book.id !== incoming.id) {
      throw new SyncError(
        "internal",
        "The imported book does not match its digest."
      );
    }
    const store = this.deps.store;
    const existing = await store.getBook(id);
    const record: BookRecord = {
      ...imported.book,
      fileName: incoming.record.fileName,
      addedAt: incoming.record.addedAt,
      lastOpenedAt: Math.max(
        incoming.record.lastOpenedAt,
        existing?.lastOpenedAt ?? 0
      ),
      updatedAt: Math.max(incoming.record.updatedAt, imported.book.updatedAt),
      deletedAt: null,
    };
    await store.putBookFile(imported.file);
    await store.putRender(imported.render);
    await store.putBook(record);
    this.summary.booksReceived += 1;
    this.deps.emit({
      type: "transfer",
      direction: "receive",
      label,
      done: incoming.size,
      total: incoming.size,
    });
    this.settleWanted(id);
  }

  private settleWanted(id: string): void {
    this.wanted.delete(id);
    this.maybeFinish();
  }

  // ----- completion -----------------------------------------------------------

  private maybeFinish(): void {
    if (this.finished) {
      return;
    }
    if (
      !this.doneSent &&
      this.requestsSent &&
      this.peerRequestsDone &&
      !this.sending &&
      this.sendQueue.length === 0 &&
      this.wanted.size === 0
    ) {
      this.doneSent = true;
      this.send({ t: "done", summary: this.summary });
    }
    if (this.doneSent && this.peerDone) {
      this.finished = true;
      clearTimeout(this.timer);
      this.deps.emit({ type: "complete", summary: this.summary });
      this.resolveDone({ peer: this.deps.peer, summary: this.summary });
    }
  }
}

function frameChunkBuffer(seq: number, chunk: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(4 + chunk.length);
  new DataView(frame.buffer).setUint32(0, seq, false);
  frame.set(chunk, 4);
  return frame.buffer;
}
