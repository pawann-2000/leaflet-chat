// Shared vitest setup. jsdom lacks IndexedDB and a few Web Crypto entry
// points; tests that need them import the polyfills explicitly so the
// dependency stays visible at the test site.
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}
