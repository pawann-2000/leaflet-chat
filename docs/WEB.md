# Leaflet on the web

The same React app that ships inside the Tauri desktop shell also runs as a
static site. The build is plain files; book processing and reading happen on
the device. Optional library transfer, reading-note pairing, and AI provider
features make network connections when started by the user.

```text
pnpm dev:web          # dev server on http://localhost:1420 (browser mode)
pnpm build:web        # dist/ (app) + dist/book-sw.js (service worker)
pnpm preview:web      # serve dist/ locally
pnpm analyze          # chunk sizes (raw / gzip / brotli) → dist/bundle-report.md
pnpm test             # Vitest
pnpm test:browser     # Chromium reader flow
```

Deploy `dist/` to a static host that serves it over HTTPS at the site root
(`/`); `docs/DEPLOY.md` walks through Cloudflare Pages for leaflet.chat.
Service workers, the camera used by QR pairing, the share target and the
file handler all require a secure context, so plain HTTP only works on
`localhost`. The build also emits `_headers` (CSP and cache rules, generated
from the same `WEB_CSP` constant that feeds the meta tag) and `_redirects`
(single-page fallback so `/join#CODE` links load the shell).

### What the build ships

- Chunks are split by library (`react`, `motion`, `yjs`, `qr`, `fflate`,
  `dompurify`, `turn`, `anthropic-sdk`) so screens that need a heavy library
  load it on demand; the shell itself is a few tens of kilobytes plus React
  and the motion runtime. Production output targets ES2022 with the
  module-preload polyfill disabled, and the Oxc minifier drops `console`
  and `debugger` statements.
- `book-sw.js` precaches the built assets (list and version hash injected at
  build time as `__LEAFLET_PRECACHE__`): hashed assets are cache-first, HTML
  routes are network-first with the cached shell as the offline fallback,
  the manifest and icons are stale-while-revalidate. Book resources under
  `/book/*` and provider/relay requests are never cached. When a new worker
  takes over an already controlled tab, `onServiceWorkerUpdate` in
  `src/lib/sw/register.ts` fires so the UI can offer a reload.
- The manifest declares a `share_target` (Android "Share → Leaflet") and a
  `file_handlers` entry ("Open with Leaflet"). Shared files land in the
  `leaflet-inbox` database and are drained with `takeInboxFiles()` from
  `src/lib/sw/inbox.ts`; launched files arrive through `watchLaunchFiles()`.

## How the host is chosen

`src/lib/platform/index.ts` picks an implementation at startup:

| Host    | File                          | Backing                                           |
| ------- | ----------------------------- | ------------------------------------------------- |
| desktop | `src/lib/platform/tauri.ts`   | Rust commands over Tauri IPC                      |
| web     | `src/lib/platform/web.ts`     | `@/lib/epub`, `@/lib/db`, `@/lib/ai`, `@/lib/sw`  |

The UI only talks to the `Platform` interface (`src/lib/platform/types.ts`)
and reads `capabilities` to decide which controls to show. The web host
enables the library shelf, stored provider keys, the Anthropic adapter and
library transfer; the desktop host opens books through Rust. Reading notes are
available in both hosts when their webview supports IndexedDB and WebRTC.

## Publication pipeline (web)

1. `importEpub` (`src/lib/epub`) reads the file, hashes it (SHA-256 → the
   book id, so the same file has the same id on every device), runs the same
   archive preflight as the Rust `reader-security` crate, and parses the OPF /
   nav / NCX. Import stages chapter summaries, publisher navigation and links;
   the selected chapter renders when opened.
2. Rendering resolves relative URLs to `https://<origin>/book/<id>/<path>`,
   sanitizes the markup with DOMPurify configured to the same allowlists as
   the Rust `ammonia` setup, and replaces every anchor with an opaque
   per-book token. The reader never sees a navigable external URL.
3. Records go to IndexedDB (`src/lib/db`): the original EPUB `Blob` plus a
   zip index, metadata, the link registry, and a small cache of recently
   rendered chapters. A damaged compressed chapter can therefore first report
   an error when that chapter is opened.
4. A service worker (`src/sw/book-sw.ts`) answers `/book/<id>/<path>` by
   reading only that entry out of the stored blob, applying IDPF font
   de-obfuscation where declared, and returning the same restrictive headers
   the desktop protocol uses. Only manifest-declared render resources are
   served; documents return 404.
5. Reading positions and trusted origins persist per book id. Yjs reading
   notes and a source-text locator persist separately under the EPUB's SHA-256
   fingerprint.

If the service worker cannot take control (unsupported browser, private
mode restrictions), the app still opens books as text; a toast explains that
images and fonts are unavailable.

## Bring your own key

The assistant panel offers presets for Ollama, LM Studio, OpenAI,
OpenRouter, Anthropic and a custom OpenAI-compatible endpoint. Requests go
straight from the browser to that endpoint. Consequences:

- The endpoint must allow the app's origin through CORS. Ollama needs
  `OLLAMA_ORIGINS` to include the site origin; hosted APIs already allow
  browser calls with a key.
- Keys stay in memory unless "Remember the key on this device" is switched
  on, which stores them in IndexedDB in plain form. Browser storage has no
  secret store; treat a remembered key like a cookie for that site.
- Anthropic requests use the official SDK in browser mode; the model list
  comes from the account, `claude-opus-5` is preselected when available, and
  no sampling parameters are sent.
- Keys are never included in device sync.

## Reading notes and direct pairing

The Notes drawer saves bookmarks, highlights, and comments with Yjs in
IndexedDB. Locators use offsets in the rendered source text, so changing
window size or turning pages does not change their target. A note whose source
passage no longer matches is reported instead of silently placed elsewhere.

Two devices can pair notes when each opens the exact same EPUB. One device
creates an offer code with a **read** or **read and annotate** grant; the other
returns a reply code. Codes are exchanged privately and expire after ten
minutes. The direct WebRTC data channel sends bounded Yjs updates and reading
positions, not EPUB bytes. Browser and network support vary: this feature uses
local network candidates and no TURN relay, so pairing can fail across some
networks. Notes remain local when that happens. The codes contain connection
details; share them only with the intended device. A read-only peer cannot
send annotation updates, and invalid peer data closes the connection.

## Transfer library between devices

The existing library transfer moves books, reading positions and trusted sites between two browsers
over a WebRTC data channel (DTLS-encrypted, peer to peer). No server holds
the data. Establishing the channel needs each side to see the other's
connection description once per session; two ways exist:

- **Manual (no server at all).** One device shows a code (QR + text); the
  other scans it with its camera or receives it pasted from any messaging
  app, then sends a reply code back the same way. Both screens then show the
  same six digits, which the user confirms before anything transfers. This
  works on phones and laptops with a camera; a laptop without a camera can
  paste the reply code. The two devices are paired automatically after the
  first confirmed session.
- **Relay (optional).** Paired devices can reconnect without codes through a
  WebSocket relay the user runs (`tools/sync-relay`). The relay only forwards
  envelopes encrypted with a key derived from the pairing; it cannot read or
  forge them, and book bytes never touch it.

Limits to know about:

- Without a relay, every sync session needs the code exchange again. That is
  inherent to serverless WebRTC.
- Two devices behind symmetric NATs may fail to connect without a TURN
  server; the app ships with a public STUN server only. Same-network pairing
  does not need STUN.
- Manual pairing over a chat app trusts that chat app to deliver the code
  unmodified; the six-digit check catches a substituted connection.

## Security posture compared with the desktop

The desktop keeps parsing and sanitizing in Rust outside the WebView. On the
web the trusted computing base is the page itself, so the same controls run
in JavaScript: DOMPurify replaces `ammonia`, the service worker replaces the
Tauri protocol, and a production `Content-Security-Policy` (injected by
`vite.config.ts` in `--mode web` builds) restricts scripts to the site, images
and fonts to the site and `data:`, and network connections to HTTPS,
loopback HTTP and WebSockets. See `SECURITY.md` in the repository root for
the shared threat model.
