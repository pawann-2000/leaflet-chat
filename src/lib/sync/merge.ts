/**
 * Pure reconciliation: given what this device holds and what the peer
 * announced, decide what to send, what to ask for and what to delete.
 *
 * Every record type merges by last-writer-wins on `updatedAt`. Tombstones
 * (`deletedAt !== null`) take part like any other version, so a deletion on
 * one device beats a stale live copy on the other, and a re-import after a
 * deletion (newer `updatedAt`) revives the book everywhere.
 */
import type {
  BookRecord,
  ProgressRecord,
  TrustedOriginRecord,
} from "@/lib/db/types";
import type {
  BookManifestItem,
  Manifest,
  ProgressManifestItem,
  TrustedManifestItem,
} from "./messages";

export interface LocalState {
  books: BookRecord[];
  progress: ProgressRecord[];
  trusted: TrustedOriginRecord[];
}

export interface SyncPlan {
  /** Peer tombstones that beat a live local copy. */
  deleteBooks: { deletedAt: number; id: string }[];
  /** Live local records that are newer than the peer's live copy (metadata only). */
  sendBookRecords: BookRecord[];
  sendProgress: ProgressRecord[];
  sendTrusted: TrustedOriginRecord[];
  /** Live peer books this device lacks (or only holds an older tombstone of). */
  wantBooks: string[];
}

const MANIFEST_TITLE = 400;

/** The version stamp of a record, whether live or tombstoned. */
export function stamp(record: {
  deletedAt: number | null;
  updatedAt: number;
}): number {
  return Math.max(record.updatedAt, record.deletedAt ?? 0);
}

export function buildManifest(local: LocalState): Manifest {
  return {
    books: local.books.map(
      (book): BookManifestItem => ({
        deletedAt: book.deletedAt,
        id: book.id,
        size: book.size,
        title: book.title.slice(0, MANIFEST_TITLE),
        updatedAt: book.updatedAt,
      })
    ),
    progress: local.progress.map(
      (item): ProgressManifestItem => ({
        bookId: item.bookId,
        updatedAt: item.updatedAt,
      })
    ),
    trusted: local.trusted.map(
      (item): TrustedManifestItem => ({
        deletedAt: item.deletedAt,
        origin: item.origin,
        updatedAt: item.updatedAt,
      })
    ),
  };
}

export function planSync(local: LocalState, peer: Manifest): SyncPlan {
  const peerProgress = new Map(
    peer.progress.map((item) => [item.bookId, item])
  );
  const peerTrusted = new Map(peer.trusted.map((item) => [item.origin, item]));
  const peerBooks = new Map(peer.books.map((item) => [item.id, item]));
  const localBooks = new Map(local.books.map((book) => [book.id, book]));

  const sendProgress = local.progress.filter((item) => {
    const theirs = peerProgress.get(item.bookId);
    return !theirs || item.updatedAt > theirs.updatedAt;
  });
  const sendTrusted = local.trusted.filter((item) => {
    const theirs = peerTrusted.get(item.origin);
    return !theirs || stamp(item) > stamp(theirs);
  });

  const wantBooks: string[] = [];
  const deleteBooks: SyncPlan["deleteBooks"] = [];
  for (const theirs of peer.books) {
    const mine = localBooks.get(theirs.id);
    if (theirs.deletedAt === null) {
      if (!mine || (mine.deletedAt !== null && stamp(theirs) > stamp(mine))) {
        wantBooks.push(theirs.id);
      }
    } else if (mine && mine.deletedAt === null && stamp(theirs) > stamp(mine)) {
      deleteBooks.push({ id: theirs.id, deletedAt: theirs.deletedAt });
    }
  }

  const sendBookRecords = local.books.filter((mine) => {
    const theirs = peerBooks.get(mine.id);
    return (
      mine.deletedAt === null &&
      theirs !== undefined &&
      theirs.deletedAt === null &&
      mine.updatedAt > theirs.updatedAt
    );
  });

  return { deleteBooks, sendBookRecords, sendProgress, sendTrusted, wantBooks };
}

/** Merge an incoming live record onto a local live one; `null` means keep local. */
export function mergeBookRecord(
  local: BookRecord,
  incoming: BookRecord
): BookRecord | null {
  if (local.deletedAt !== null || incoming.deletedAt !== null) {
    return null;
  }
  if (incoming.updatedAt <= local.updatedAt) {
    return null;
  }
  return {
    ...incoming,
    addedAt: local.addedAt,
    lastOpenedAt: Math.max(local.lastOpenedAt, incoming.lastOpenedAt),
  };
}
