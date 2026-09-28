# Leaflet

Leaflet is a local-first EPUB reader for the browser and Tauri desktop. It keeps the book-turn animation while showing the publication's actual chapter content, images, publisher styles, and table of contents. On smaller screens it turns one page at a time.

## Run it

```bash
npm ci
npm run dev:web       # browser app
npm run build:web     # static app and book service worker in dist/
npm run tauri dev     # desktop app; requires the Tauri system dependencies
```

Import an EPUB using the file picker or drop one on the browser window. The browser library, reading positions, notes, and highlights stay in local storage. The desktop app reads EPUBs through its Rust host.

The **Notes** button in the reader saves bookmarks, highlights, and comments per exact EPUB. The pairing section exchanges manual WebRTC codes with another device that has the same EPUB. The offering device chooses whether the joining device can read notes or annotate them. This pairing sends notes and reading positions; the separate **Transfer library** feature on the web moves EPUB files and library data.

## Checks

```bash
npm run typecheck
npm test
npm run test:browser   # needs Chromium; checks EPUB import, page turn, and notes UI
npm run build:web
```

See [web architecture and deployment](docs/WEB.md) for storage, networking, and security details.
