// biome-ignore-all lint/suspicious/useAwait: the fake keeps the store's async signatures without any I/O to await
/** In-memory `LeafletStore` for sync tests; mirrors the LWW rules of the real store. */
import type {
  BookFileRecord,
  BookRecord,
  BookRenderRecord,
  LeafletStore,
  PeerRecord,
  ProgressRecord,
  ReadingDayRecord,
  ReadingSessionRecord,
  SettingKey,
  SettingsMap,
  TrustedOriginRecord,
} from "@/lib/db/types";
import type { LibraryBook } from "@/lib/types";

export class FakeStore implements LeafletStore {
  readonly books = new Map<string, BookRecord>();
  readonly files = new Map<string, BookFileRecord>();
  readonly renders = new Map<string, BookRenderRecord>();
  readonly progress = new Map<string, ProgressRecord>();
  readonly trusted = new Map<string, TrustedOriginRecord>();
  readonly peers = new Map<string, PeerRecord>();
  readonly settings = new Map<string, unknown>();
  readonly readingDays = new Map<string, ReadingDayRecord>();
  readonly readingSessions = new Map<string, ReadingSessionRecord>();

  async listBooks(): Promise<LibraryBook[]> {
    return [...this.books.values()]
      .filter((book) => book.deletedAt === null)
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map((book) => ({
        addedAt: book.addedAt,
        authors: book.authors,
        chapterCount: book.chapterCount,
        coverDataUrl: null,
        fileName: book.fileName,
        id: book.id,
        lastOpenedAt: book.lastOpenedAt,
        size: book.size,
        title: book.title,
      }));
  }

  async getBook(id: string): Promise<BookRecord | undefined> {
    return this.books.get(id);
  }

  async allBookRecords(): Promise<BookRecord[]> {
    return [...this.books.values()];
  }

  async putBook(record: BookRecord): Promise<void> {
    this.books.set(record.id, { ...record });
  }

  async deleteBook(id: string, deletedAt = Date.now()): Promise<void> {
    const book = this.books.get(id);
    if (book) {
      this.books.set(id, { ...book, deletedAt, updatedAt: deletedAt });
    }
    this.files.delete(id);
    this.renders.delete(id);
  }

  async touchBook(id: string, lastOpenedAt: number): Promise<void> {
    const book = this.books.get(id);
    if (book) {
      this.books.set(id, { ...book, lastOpenedAt, updatedAt: lastOpenedAt });
    }
  }

  async getBookFile(id: string): Promise<BookFileRecord | undefined> {
    return this.files.get(id);
  }

  async putBookFile(record: BookFileRecord): Promise<void> {
    this.files.set(record.id, record);
  }

  async getRender(id: string): Promise<BookRenderRecord | undefined> {
    return this.renders.get(id);
  }

  async putRender(record: BookRenderRecord): Promise<void> {
    this.renders.set(record.id, record);
  }

  async getProgress(bookId: string): Promise<ProgressRecord | undefined> {
    return this.progress.get(bookId);
  }

  async allProgress(): Promise<ProgressRecord[]> {
    return [...this.progress.values()];
  }

  async putProgress(record: ProgressRecord): Promise<boolean> {
    const current = this.progress.get(record.bookId);
    if (current && current.updatedAt >= record.updatedAt) {
      return false;
    }
    this.progress.set(record.bookId, { ...record });
    return true;
  }

  async listTrustedOrigins(): Promise<TrustedOriginRecord[]> {
    return [...this.trusted.values()].filter((item) => item.deletedAt === null);
  }

  async allTrustedOriginRecords(): Promise<TrustedOriginRecord[]> {
    return [...this.trusted.values()];
  }

  async isOriginTrusted(origin: string): Promise<boolean> {
    return this.trusted.get(origin)?.deletedAt === null;
  }

  async trustOrigin(origin: string, now = Date.now()): Promise<void> {
    this.trusted.set(origin, {
      origin,
      trustedAt: Math.floor(now / 1000),
      updatedAt: now,
      deletedAt: null,
    });
  }

  async revokeOrigin(origin: string, now = Date.now()): Promise<void> {
    const current = this.trusted.get(origin);
    if (current) {
      this.trusted.set(origin, { ...current, deletedAt: now, updatedAt: now });
    }
  }

  async revokeAllOrigins(now = Date.now()): Promise<void> {
    for (const origin of this.trusted.keys()) {
      await this.revokeOrigin(origin, now);
    }
  }

  async putTrustedOriginRecord(record: TrustedOriginRecord): Promise<boolean> {
    const current = this.trusted.get(record.origin);
    const incoming = Math.max(record.updatedAt, record.deletedAt ?? 0);
    if (
      current &&
      Math.max(current.updatedAt, current.deletedAt ?? 0) >= incoming
    ) {
      return false;
    }
    this.trusted.set(record.origin, { ...record });
    return true;
  }

  async listPeers(): Promise<PeerRecord[]> {
    return [...this.peers.values()];
  }

  async putPeer(record: PeerRecord): Promise<void> {
    this.peers.set(record.deviceId, { ...record });
  }

  async deletePeer(deviceId: string): Promise<void> {
    this.peers.delete(deviceId);
  }

  async getReadingDay(date: string): Promise<ReadingDayRecord | undefined> {
    return this.readingDays.get(date);
  }

  async putReadingDay(record: ReadingDayRecord): Promise<void> {
    this.readingDays.set(record.date, { ...record });
  }

  async listReadingDays(sinceDate: string): Promise<ReadingDayRecord[]> {
    return [...this.readingDays.values()]
      .filter((day) => day.date >= sinceDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async putReadingSession(record: ReadingSessionRecord): Promise<void> {
    this.readingSessions.set(record.id, { ...record });
  }

  async listReadingSessions(bookId?: string): Promise<ReadingSessionRecord[]> {
    return [...this.readingSessions.values()]
      .filter((session) => bookId === undefined || session.bookId === bookId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  async getSetting<K extends SettingKey>(
    key: K
  ): Promise<SettingsMap[K] | undefined> {
    return this.settings.get(key) as SettingsMap[K] | undefined;
  }

  async putSetting<K extends SettingKey>(
    key: K,
    value: SettingsMap[K]
  ): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: SettingKey): Promise<void> {
    this.settings.delete(key);
  }
}
