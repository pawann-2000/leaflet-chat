# Reading in Leaflet

What happens between opening a book and closing it: the page-turn reader,
selection actions, notes, reading time, speed reading and reading rooms.
Build and hosting live in `WEB.md`; the relay in `ROOMS.md`.

## The reader

Books render as a paginated, page-turning codex (two leaves on wide screens,
one on phones). Publication markup is sanitized before it reaches the page;
publisher CSS is scoped to the page copy; images, fonts and covers come
through the book protocol served by the service worker. Chapters render
lazily the first time the reader reaches them.

Positions are stored two ways:

- a coarse chapter/progress pair per book (also used by device transfer), and
- a precise locator (chapter id + character offsets into the chapter's
  source text) kept with the notes, which is what "Resume" restores.

## Selecting text

Selecting anything in the book raises a small floating toolbar next to the
selection (below it on touch screens so the platform's own handles stay
reachable):

| Action    | Effect                                                              |
| --------- | ------------------------------------------------------------------- |
| Highlight | Saves a gold highlight (visible on every device that shares notes). |
| Note      | Opens the Notes panel with a compose box quoting the passage.       |
| Copy      | Copies the text.                                                    |
| Ask       | Sends the passage to the assistant panel as context.                |
| Speed     | Starts the speed reader at the selection.                           |

Escape clears the selection. In a read-only reading room, Highlight and Note
are disabled; Copy, Ask and Speed always work.

## Notes

The sidebar's Notes tab lists highlights, notes and bookmarks (`B` bookmarks
the current page). Each entry jumps back to its passage. Notes belong to the
book's fingerprint (the SHA-256 of the EPUB), so the same file on another
device shows the same notes once it has synced through a room, and a note
whose passage no longer matches the text is reported instead of misplaced.

## Reading time, goal and streak

While a book is open a timer counts active reading: it pauses after ninety
seconds without a page turn, selection, key press or pointer movement, when
the tab is hidden, and when the window is closed. The header chip shows the
sitting's clock with a breathing dot while counting.

Every fifteen seconds the sitting is folded into a per-day ledger in
IndexedDB (seconds, words on the pages shown, pages, books). From it the
library page derives today's ring against the daily goal (default fifteen
minutes; 10–60 selectable), the streak of consecutive days above the goal (a
day counts from one minute for short goals), a 28-day calendar, total words
and a seven-day average words per minute. Reaching the goal shows a short
sparkle once per day. Statistics are per device; they are not part of device
transfer yet.

## Speed reading

`S`, the header bolt, the phone action bar, or the selection toolbar opens
the speed reader over the book. It shows one frame at a time (one, two or
three words) with the optimal recognition point pinned to the same column
every frame, so the eye never moves. Speed ramps from 60% of the target to
the target over the first eight seconds; punctuation and long words hold a
little longer, paragraph ends longer still.

Controls: Space or `K` plays and pauses, `←`/`→` skip a sentence, `↑`/`↓`
change the speed by 25 wpm (100–1200), `1`/`2`/`3` set the chunk size, and
Escape returns to the book at the frame that was showing. Words shown count
towards reading statistics. Speed and chunk size persist per device.

## Reading rooms

"Read together" turns a book into a room. The host gets a code such as
`ABCD-EFGH-JKLM`, a QR code and a link (`https://leaflet.chat/join#CODE`).
Anyone who opens the exact same EPUB and enters the code joins; up to sixteen
readers see each other's names, colours and current page, can jump to a
member's page, or follow one so their own book turns with them. Highlights
and notes merge live (Yjs). The host can lock the room so guests read without
annotating, remove a member, or leave (which ends the room).

Opening a join link on a device that already has the book on its shelf opens
the book and joins straight away; otherwise the app names the book to add.

Everything that travels is encrypted end to end with a key derived from the
code; the relay at `rooms.leaflet.chat` sees only a hash of the code, member
ids, channel labels and ciphertext (see `ROOMS.md`). A self-hosted relay can
be set in the drawer's "Use your own relay" field.

## Keyboard summary

| Key         | Action                     |
| ----------- | -------------------------- |
| `←` / `→`   | Turn leaves                |
| `S`         | Speed read from here       |
| `N`         | Notes and highlights       |
| `B`         | Bookmark this page         |
| `T`         | Read together              |
| `⌘B`        | Sidebar                    |
| `⌘K`        | Commands                   |
| Escape      | Close overlays / clear selection |
