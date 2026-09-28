import type {
  Chapter,
  ChatEvent,
  ChatRequest,
  ExternalOpenMode,
  LibraryBook,
  LinkTarget,
  Model,
  OpenedPublication,
  ProviderConfig,
  ProviderKind,
  ReadingPosition,
  TrustedSite,
} from "@/lib/types";

/**
 * Everything the UI needs from the host it runs in.
 *
 * Two implementations exist: `tauri.ts` forwards to the Rust commands of the
 * desktop app, `web.ts` runs the whole pipeline in the browser (EPUB parsing,
 * IndexedDB library, service-worker resource protocol, direct provider calls).
 *
 * Optional members are capabilities a host may lack; the UI must read
 * `capabilities` and hide the affected controls instead of calling into a
 * missing method.
 */
export interface Platform {
  readonly capabilities: PlatformCapabilities;

  /** Open a book through the host's native picker. Resolves `null` on cancel. */
  chooseAndOpenBook(): Promise<OpenedPublication | null>;
  /** Free any open-book resources held by the host (rendered chapters, link registry). */
  closeBook?(bookId: string): Promise<void>;
  readonly kind: "desktop" | "web";

  /** Library (web only). */
  listLibrary?(): Promise<LibraryBook[]>;

  listModels(provider: ProviderConfig): Promise<Model[]>;

  /** Saved positions for every book in the library, keyed by book id (web only). */
  listProgress?(): Promise<Record<string, StoredProgress>>;
  listTrustedSites(): Promise<TrustedSite[]>;

  /** Load source content for one spine item when the reader reaches it. */
  loadChapter(bookId: string, index: number): Promise<Chapter>;

  loadProgress?(bookId: string): Promise<ReadingPosition | null>;

  /** Persisted assistant settings (web only). Desktop keeps tokens in memory. */
  loadProviderConfig?(): Promise<ProviderConfig | null>;
  /** Web only: open (and add to the library) a file the page already holds. */
  openBookFile?(file: File): Promise<OpenedPublication>;
  openExternalLink(requestId: string, mode: ExternalOpenMode): Promise<void>;
  openLibraryBook?(id: string): Promise<OpenedPublication>;
  removeLibraryBook?(id: string): Promise<void>;

  resolveBookLink(bookId: string, href: string): Promise<LinkTarget>;
  revokeAllTrustedSites(): Promise<void>;
  revokeTrustedSite(origin: string): Promise<void>;
  saveProgress(
    bookId: string,
    chapterIndex: number,
    progress: number
  ): Promise<void>;
  saveProviderConfig?(config: ProviderConfig | null): Promise<void>;
  /** A degraded-mode message to show once at startup, if any. */
  readonly startupNotice?: string | null;
  streamChat(
    request: ChatRequest,
    receive: (event: ChatEvent) => void,
    signal?: AbortSignal
  ): Promise<void>;
}

export interface StoredProgress extends ReadingPosition {
  /** Milliseconds since the epoch of the last save. */
  updatedAt: number;
}

export interface PlatformCapabilities {
  /** Books persist on the device and can be reopened from a shelf. */
  library: boolean;
  /** Wire protocols the host can speak. */
  providers: ProviderKind[];
  /** The host can remember a provider API key between sessions. */
  storedKeys: boolean;
  /** Cross-device sync through device pairing. */
  sync: boolean;
}
