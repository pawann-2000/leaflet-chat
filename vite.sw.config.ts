import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

/**
 * Builds the service worker as one classic script at a stable path
 * (`dist/book-sw.js`) so `navigator.serviceWorker.register` can find it
 * without a manifest lookup.
 *
 * Runs after the main `--mode web` build (see `build:web`): it lists what
 * that build produced and injects the list, plus a version hash, as the
 * `__LEAFLET_PRECACHE__` constant the worker precaches. When `dist/` holds
 * no app build (worker built on its own) the list is empty and the worker
 * only serves the book protocol.
 */
const root = import.meta.dirname;
const dist = path.resolve(root, "dist");

function listFiles(directory: string, prefix: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => statSync(path.join(directory, name)).isFile())
    .sort()
    .map((name) => `${prefix}/${name}`);
}

function shellManifest(): { assets: string[]; version: string } {
  const index = path.join(dist, "index.html");
  if (!existsSync(index)) {
    return { assets: [], version: "dev" };
  }
  // The shell document itself is precached as "/" by the worker; static
  // hosts redirect "/index.html" there, so it is never listed by name.
  const assets = [
    "/manifest.webmanifest",
    ...listFiles(path.join(dist, "assets"), "/assets"),
    ...listFiles(path.join(dist, "icons"), "/icons"),
  ].filter((asset) => existsSync(path.join(dist, asset)));
  const hash = createHash("sha256");
  hash.update(readFileSync(index));
  for (const asset of assets) {
    hash.update(asset);
  }
  return { assets, version: hash.digest("hex").slice(0, 12) };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
    },
  },
  define: {
    __LEAFLET_PRECACHE__: JSON.stringify(shellManifest()),
  },
  build: {
    emptyOutDir: false,
    target: "es2022",
    lib: {
      entry: path.resolve(root, "src/sw/book-sw.ts"),
      name: "LeafletBookWorker",
      formats: ["iife"],
      fileName: () => "book-sw.js",
    },
  },
});
