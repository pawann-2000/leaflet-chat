export interface BookSummary {
  authors: string[];
  chapterCount: number;
  coverDataUrl: string | null;
  /** SHA-256 of publication bytes, stable across local imports and peers. */
  fingerprint: string;
  id: string;
  language: string | null;
  pageDirection: "default" | "left-to-right" | "right-to-left";
  sourcePath: string;
  title: string;
}

export interface ChapterSummary {
  id: string;
  index: number;
  title: string;
}

export interface OpenedBook {
  chapters: ChapterSummary[];
  documents: PublicationDocument[];
  navigation: TocEntry[];
  summary: BookSummary;
}

/** Any readable manifest document, including notes outside the spine. */
export interface PublicationDocument {
  chapterIndex: number | null;
  id: string;
  /** Opaque token resolved through the platform's publication link handler. */
  link: string;
  title: string;
}

/** One publication TOC destination, independent of the spine reading order. */
export interface TocEntry {
  chapterId: string;
  chapterIndex: number | null;
  depth: number;
  fragment: string | null;
  id: string;
  /** Opaque token resolved through the platform's publication link handler. */
  link: string;
  title: string;
}

export interface OpenedPublication {
  book: OpenedBook;
  chapters: Chapter[];
}

export interface Chapter {
  baseUrl: string;
  direction: "auto" | "ltr" | "rtl" | null;
  html: string;
  id: string;
  index: number;
  inlineStyles: string[];
  language: string | null;
  plainText: string;
  stylesheets: string[];
  title: string;
}

export type LinkTarget =
  | {
      kind: "internal";
      chapter: Chapter;
      chapterIndex: number | null;
      fragment: string | null;
    }
  | {
      kind: "external";
      requestId: string;
      url: string;
      origin: string | null;
      trusted: boolean;
    };

export type ExternalOpenMode = "once" | "trust" | "trusted";

export interface TrustedSite {
  origin: string;
  /** Unix seconds. */
  trustedAt: number;
}

/** A book kept in the on-device library (web platform only). */
export interface LibraryBook {
  addedAt: number;
  authors: string[];
  chapterCount: number;
  coverDataUrl: string | null;
  fileName: string;
  /** SHA-256 hex digest of the EPUB bytes; identical files share an id across devices. */
  id: string;
  lastOpenedAt: number;
  size: number;
  title: string;
}

export interface ReadingPosition {
  chapterIndex: number;
  progress: number;
}

export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderConfig {
  allowRemote: boolean;
  apiKey: string | null;
  baseUrl: string;
  /** Wire protocol used to talk to the endpoint. Desktop only supports "openai-compatible". */
  kind: ProviderKind;
  name: string;
}

export interface Model {
  id: string;
  ownedBy: string | null;
}

export interface ChatMessage {
  content: string;
  role: "system" | "user" | "assistant";
}

export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
  provider: ProviderConfig;
  temperature: number | null;
}

export type ChatEvent = { type: "delta"; content: string } | { type: "done" };

export interface CommandError {
  code?: string;
  message?: string;
}
