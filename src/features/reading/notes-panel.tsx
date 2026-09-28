import {
  Bookmark,
  Highlighter,
  MessageSquareText,
  Sparkles,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/motion/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import type { ContentLocator, ReaderSelection } from "@/lib/reader/locator";
import type { Annotation, ReadingSession } from "@/lib/reading-sync";
import { MAX_COMMENT } from "@/lib/reading-sync";
import { cn } from "@/lib/utils";

type NoteFilter = "all" | Annotation["kind"] | "mine";

const KIND_LABEL: Record<Annotation["kind"], string> = {
  bookmark: "Bookmark",
  comment: "Note",
  highlight: "Highlight",
};

const KIND_ICON: Record<Annotation["kind"], typeof Bookmark> = {
  bookmark: Bookmark,
  comment: MessageSquareText,
  highlight: Highlighter,
};

const CONFIRM_WINDOW = 4000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work.";
}

function NoteCard({
  note,
  mine,
  canEdit,
  onNavigate,
  onRemove,
}: {
  note: Annotation;
  mine: boolean;
  canEdit: boolean;
  onNavigate: (locator: ContentLocator) => void;
  onRemove: (id: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  const Icon = KIND_ICON[note.kind];
  useEffect(() => {
    if (!armed) {
      return;
    }
    const timer = setTimeout(() => setArmed(false), CONFIRM_WINDOW);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <li className="note-card paper rounded-2xl p-3">
      <div className="flex items-center gap-2">
        <Icon
          aria-hidden="true"
          className={cn(
            "size-3.5",
            note.kind === "highlight" ? "text-gold-foreground" : "text-coral"
          )}
        />
        <span className="eyebrow">{KIND_LABEL[note.kind]}</span>
        {note.author && (
          <span
            className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground"
            title={mine ? "You" : note.author.name}
          >
            <span
              aria-hidden="true"
              className="inline-block size-2 rounded-full"
              style={{ background: note.author.color }}
            />
            {mine ? "You" : note.author.name}
          </span>
        )}
      </div>
      <button
        className="mt-2 block w-full text-left"
        onClick={() => onNavigate(note.locator)}
        type="button"
      >
        <p
          className={cn(
            "font-serif text-sm leading-snug",
            note.kind === "highlight" &&
              "rounded-sm bg-[color-mix(in_oklch,var(--gold)_45%,transparent)] decoration-clone px-1"
          )}
        >
          {note.locator.quote
            ? `“${note.locator.quote.length > 220 ? `${note.locator.quote.slice(0, 220)}…` : note.locator.quote}”`
            : "Saved page"}
        </p>
        {note.text && (
          <p className="mt-2 whitespace-pre-wrap text-foreground text-sm">
            {note.text}
          </p>
        )}
      </button>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button
          onClick={() => onNavigate(note.locator)}
          size="sm"
          variant="ghost"
        >
          Go to passage
        </Button>
        {canEdit && (
          <Button
            aria-label={armed ? "Confirm delete" : "Delete note"}
            className={cn(
              armed && "bg-destructive text-white hover:bg-destructive"
            )}
            onBlur={() => setArmed(false)}
            onClick={() => {
              if (armed) {
                setArmed(false);
                onRemove(note.id);
              } else {
                setArmed(true);
              }
            }}
            size={armed ? "sm" : "icon"}
            variant="ghost"
          >
            <Trash2 className="size-4" />
            {armed && "Delete?"}
          </Button>
        )}
      </div>
    </li>
  );
}

function Compose({
  selection,
  onSave,
  onCancel,
}: {
  selection: ReaderSelection;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <div className="paper rounded-2xl p-3">
      <p className="eyebrow">New note</p>
      <blockquote className="mt-2 max-h-24 overflow-y-auto border-gold border-l-4 pl-3 font-serif text-sm leading-snug">
        {selection.text}
      </blockquote>
      <textarea
        aria-label="Your note"
        className="mt-3 min-h-20 w-full rounded-xl border border-border bg-background p-2 text-sm"
        maxLength={MAX_COMMENT}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (draft.trim()) {
              onSave(draft);
            }
          }
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        placeholder="What did this make you think?"
        ref={field}
        value={draft}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {draft.length} / {MAX_COMMENT}
        </span>
        <div className="flex gap-2">
          <Button onClick={onCancel} size="sm" variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={!draft.trim()}
            onClick={() => onSave(draft)}
            size="sm"
          >
            Save note
          </Button>
        </div>
      </div>
    </div>
  );
}

export function NotesPanel({
  session,
  revision,
  compose,
  location,
  readerId,
  onComposeDone,
  onNavigate,
  onOpenTogether,
  onError,
}: {
  session: ReadingSession | null;
  /** Bumps whenever the session changes; keeps the memoised list fresh. */
  revision: number;
  /** A selection the user chose "Note" for; shows the compose box. */
  compose: ReaderSelection | null;
  location: ContentLocator | null;
  /** This browser's author id, to mark "mine". */
  readerId: string | null;
  onComposeDone: () => void;
  onNavigate: (locator: ContentLocator) => void;
  onOpenTogether: () => void;
  onError: (message: string) => void;
}) {
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [shown, setShown] = useState(40);
  const notes = session?.annotations ?? [];
  const room = session?.room ?? null;
  const canEdit = Boolean(session?.canAnnotate);
  const filtered = notes
    .filter((note) => {
      if (filter === "all") {
        return true;
      }
      if (filter === "mine") {
        return !note.author || note.author.id === readerId;
      }
      return note.kind === filter;
    })
    .reverse();
  const counts = {
    highlight: notes.filter((note) => note.kind === "highlight").length,
    comment: notes.filter((note) => note.kind === "comment").length,
    bookmark: notes.filter((note) => note.kind === "bookmark").length,
  };

  function attempt(action: () => void) {
    try {
      action();
    } catch (error) {
      onError(messageOf(error));
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      data-revision={revision}
    >
      <button
        className={cn(
          "paper flex items-center gap-3 rounded-2xl p-3 text-left transition-colors hover:bg-muted/60",
          room && "border border-coral/40"
        )}
        onClick={onOpenTogether}
        type="button"
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-coral/15 text-coral">
          <Users className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {room ? `Reading room · ${room.code}` : "Read together"}
          </span>
          <span className="block truncate text-muted-foreground text-xs">
            {room
              ? `${room.members.length} ${room.members.length === 1 ? "reader" : "readers"} · ${room.status}`
              : "Share a short code so friends can read along."}
          </span>
        </span>
        {room && (
          <span className="flex -space-x-1">
            {room.members.slice(0, 4).map((member) => (
              <span
                aria-hidden="true"
                className="inline-block size-3.5 rounded-full border-2 border-card"
                key={member.id}
                style={{ background: member.color }}
                title={member.name}
              />
            ))}
          </span>
        )}
      </button>

      {compose && session && (
        <Compose
          onCancel={onComposeDone}
          onSave={(text) => {
            attempt(() => {
              session.add("comment", compose.locator, text);
              onComposeDone();
            });
          }}
          selection={compose}
        />
      )}

      <div className="flex items-center gap-2">
        <Tabs
          onValueChange={(value) => {
            setFilter(value as NoteFilter);
            setShown(40);
          }}
          value={filter}
          variant="segment"
        >
          <TabsList className="flex w-full">
            <TabsTrigger className="flex-1" value="all">
              All
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="highlight">
              ✦ {counts.highlight}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="comment">
              ✎ {counts.comment}
            </TabsTrigger>
            <TabsTrigger className="flex-1" value="bookmark">
              ⌇ {counts.bookmark}
            </TabsTrigger>
            {room && (
              <TabsTrigger className="flex-1" value="mine">
                Mine
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>

      <Button
        className="justify-start"
        disabled={!(canEdit && location && session)}
        onClick={() =>
          attempt(() => {
            if (session && location) {
              session.add("bookmark", location);
            }
          })
        }
        size="sm"
        variant="outline"
      >
        <Bookmark className="size-4" />
        Bookmark this page
      </Button>

      {filtered.length === 0 && (
        <div className="rounded-2xl border border-border border-dashed p-4 text-center">
          <Sparkles className="mx-auto size-4 text-gold-foreground" />
          <p className="mt-2 font-serif text-sm">
            {notes.length
              ? "Nothing here yet under this filter."
              : "Select a passage to highlight it, note it, or ask about it."}
          </p>
          {!notes.length && (
            <p className="mt-1 text-muted-foreground text-xs">
              Your highlights, notes and bookmarks collect here and travel with
              the book.
            </p>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {filtered.slice(0, shown).map((note) => (
          <NoteCard
            canEdit={canEdit}
            key={note.id}
            mine={!note.author || note.author.id === readerId}
            note={note}
            onNavigate={onNavigate}
            onRemove={(id) =>
              attempt(() => {
                session?.remove(id);
              })
            }
          />
        ))}
      </ul>
      {shown < filtered.length && (
        <Button
          onClick={() => setShown((count) => count + 40)}
          size="sm"
          variant="outline"
        >
          Show more
        </Button>
      )}
    </div>
  );
}
