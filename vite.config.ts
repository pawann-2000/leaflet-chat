import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Content-Security-Policy for the browser build — the single source for both
 * the `<meta http-equiv>` tag injected into `index.html` and the `_headers`
 * file emitted for Cloudflare Pages / Netlify-style hosts. The desktop build
 * gets its policy from `src-tauri/tauri.conf.json` instead, so this is only
 * applied in `--mode web`, and only for `build` (the dev server needs inline
 * scripts for React refresh).
 *
 * - `connect-src` must reach the user's own providers and relays: any HTTPS
 *   origin, loopback HTTP for Ollama/LM Studio, and ws(s) for the reading
 *   rooms relay (`wss://rooms.leaflet.chat`) or a self-hosted one.
 * - Book assets come from the service worker under the app origin ('self').
 * - `style-src 'unsafe-inline'` is required because publisher CSS is injected
 *   as a `<style>` element after scoping; publication markup is sanitized
 *   before it reaches the document.
 * - `frame-ancestors` only works as a header, so it lives in `_headers`.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:* ws: wss: wss://rooms.leaflet.chat",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];

export const WEB_CSP = CSP_DIRECTIVES.join("; ");

/** Same policy, plus the header-only directive. */
const HEADER_CSP = [...CSP_DIRECTIVES, "frame-ancestors 'none'"].join("; ");

/**
 * `_headers` for static hosts (Cloudflare Pages, Netlify). Hashed assets are
 * immutable; the shell, the service worker and the manifest must always be
 * revalidated so a deploy reaches open tabs on their next load.
 */
export function webHeadersFile(): string {
  return [
    "/*",
    `  Content-Security-Policy: ${HEADER_CSP}`,
    "  X-Content-Type-Options: nosniff",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Permissions-Policy: camera=(self), microphone=(), geolocation=()",
    "  Cross-Origin-Opener-Policy: same-origin",
    "",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
    "/",
    "  Cache-Control: no-cache",
    "",
    "/index.html",
    "  Cache-Control: no-cache",
    "",
    "/book-sw.js",
    "  Cache-Control: no-cache",
    "",
    "/manifest.webmanifest",
    "  Cache-Control: no-cache",
    "",
  ].join("\n");
}

/**
 * `_redirects`: single-page-app fallback so deep links such as `/join#CODE`
 * resolve to the shell. Real files (assets, icons, the worker, the manifest)
 * are matched by the host before this rule.
 */
export function webRedirectsFile(): string {
  return "/*  /index.html  200\n";
}

function webPlatform(mode: string, command: string): Plugin {
  const enabled = mode === "web";
  return {
    name: "leaflet-web-platform",
    transformIndexHtml(html) {
      if (!(enabled && command === "build")) {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "meta",
            injectTo: "head-prepend",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: WEB_CSP,
            },
          },
        ],
      };
    },
    generateBundle() {
      if (!(enabled && command === "build")) {
        return;
      }
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: webHeadersFile(),
      });
      this.emitFile({
        type: "asset",
        fileName: "_redirects",
        source: webRedirectsFile(),
      });
    },
    configureServer(server) {
      // The dev service worker lives under /src/sw/ but must control "/".
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/src/sw/")) {
          res.setHeader("Service-Worker-Allowed", "/");
        }
        next();
      });
    },
  };
}

/**
 * Manual chunk groups for the browser build. Each heavy library that only a
 * few screens need becomes its own chunk, so `React.lazy` boundaries around
 * those screens actually keep the bytes off the first load. Vendor libraries
 * that every page needs share one stable chunk that survives app deploys.
 */
const CHUNK_GROUPS = [
  { name: "anthropic-sdk", test: /node_modules[\\/]@anthropic-ai[\\/]/u },
  {
    name: "yjs",
    test: /node_modules[\\/](yjs|y-indexeddb|lib0|isomorphic\.js)[\\/]/u,
  },
  {
    name: "qr-libs",
    test: /node_modules[\\/](qrcode|jsqr|dijkstrajs|encode-utf8|pngjs)[\\/]/u,
  },
  { name: "fflate", test: /node_modules[\\/]fflate[\\/]/u },
  { name: "dompurify", test: /node_modules[\\/]dompurify[\\/]/u },
  { name: "turn", test: /node_modules[\\/]svelte-turn-page[\\/]/u },
  {
    name: "motion",
    test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/u,
  },
  {
    name: "react",
    test: /node_modules[\\/](react|react-dom|react-router|scheduler|@radix-ui)[\\/]/u,
  },
].map((group, index, groups) => ({
  ...group,
  priority: groups.length - index,
}));

// https://vitejs.dev/config/
export default defineConfig(({ mode, command }) => ({
  plugins: [react(), tailwindcss(), webPlatform(mode, command)],

  // Vite options tailored for Tauri 2 development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Browser mode is meant to be tried from a phone: listen on every
    // interface and accept Tailscale hostnames (the DNS-rebinding guard
    // otherwise refuses anything but localhost).
    ...(mode === "web"
      ? { host: true, allowedHosts: [".ts.net", "den-home.taile64d34.ts.net"] }
      : { allowedHosts: ["den-home.taile64d34.ts.net"] }),
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Modern engines only: every target browser ships ES2022 and native
    // `<link rel="modulepreload">`, so neither syntax lowering nor the
    // preload polyfill earns its bytes.
    target: "es2022",
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
    reportCompressedSize: true,
    // The reader chunk legitimately carries the page-turn engine and the
    // reader UI together; warn only when a chunk grows past that.
    chunkSizeWarningLimit: 420,
    rolldownOptions: {
      output: {
        // `includeDependenciesRecursively` (rolldown's default) would also pull
        // shared helpers a library depends on — such as Vite's module-preload
        // helper — into that library's chunk, making every other chunk import
        // it and defeating the split. Groups therefore capture only the
        // modules their `test` matches.
        codeSplitting: {
          groups: CHUNK_GROUPS,
          includeDependenciesRecursively: false,
        },
        // Vite's default is plain `true`; the object form lets the Oxc
        // minifier also strip console/debugger statements in production.
        minify:
          command === "build"
            ? {
                compress: { dropConsole: true, dropDebugger: true },
                mangle: true,
                codegen: true,
              }
            : undefined,
      },
    },
  },

  // Shadcn UI
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
}));
