import { describe, expect, it } from "vitest";
import {
  classifyRequest,
  isCacheableResponse,
  isShellCache,
  precacheUrls,
  shareTargetFiles,
  shellCacheName,
  storableResponse,
} from "@/sw/shell";

const ORIGIN = "https://leaflet.chat";
const request = (
  path: string,
  init: { method?: string; mode?: string; accept?: string } = {}
) => ({
  url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
  method: init.method ?? "GET",
  mode: init.mode,
  headers: {
    get: (name: string) => (name === "accept" ? (init.accept ?? null) : null),
  },
});

describe("classifyRequest", () => {
  it("routes book resources to the protocol regardless of method", () => {
    expect(
      classifyRequest(request(`/book/${"a".repeat(64)}/x.css`), ORIGIN)
    ).toBe("book");
    expect(
      classifyRequest(
        request(`/book/${"a".repeat(64)}/x.css`, { method: "POST" }),
        ORIGIN
      )
    ).toBe("book");
  });

  it("recognises the share target only for POST", () => {
    expect(
      classifyRequest(request("/share-target", { method: "POST" }), ORIGIN)
    ).toBe("share-target");
    expect(
      classifyRequest(request("/share-target", { mode: "navigate" }), ORIGIN)
    ).toBe("navigation");
  });

  it("treats hashed assets and static files differently from documents", () => {
    expect(classifyRequest(request("/assets/index-abc.js"), ORIGIN)).toBe(
      "asset"
    );
    expect(classifyRequest(request("/assets/index-abc.css"), ORIGIN)).toBe(
      "asset"
    );
    expect(classifyRequest(request("/manifest.webmanifest"), ORIGIN)).toBe(
      "static"
    );
    expect(classifyRequest(request("/icons/icon-128.png"), ORIGIN)).toBe(
      "static"
    );
  });

  it("classifies navigations by mode or by an HTML accept header", () => {
    expect(classifyRequest(request("/", { mode: "navigate" }), ORIGIN)).toBe(
      "navigation"
    );
    expect(
      classifyRequest(request("/join", { mode: "navigate" }), ORIGIN)
    ).toBe("navigation");
    expect(
      classifyRequest(
        request("/?inbox=1", { accept: "text/html,application/xhtml+xml" }),
        ORIGIN
      )
    ).toBe("navigation");
    expect(
      classifyRequest(
        request("/api/data", { accept: "application/json" }),
        ORIGIN
      )
    ).toBe("passthrough");
  });

  it("passes through cross-origin, non-GET, dev-server and worker requests", () => {
    expect(
      classifyRequest(
        request("https://api.openai.com/v1/models", { mode: "navigate" }),
        ORIGIN
      )
    ).toBe("passthrough");
    expect(
      classifyRequest(request("/assets/x.js", { method: "POST" }), ORIGIN)
    ).toBe("passthrough");
    expect(classifyRequest(request("/book-sw.js"), ORIGIN)).toBe("passthrough");
    expect(classifyRequest(request("/src/sw/book-sw.ts"), ORIGIN)).toBe(
      "passthrough"
    );
    expect(classifyRequest(request("/@vite/client"), ORIGIN)).toBe(
      "passthrough"
    );
    expect(
      classifyRequest(request("/node_modules/.vite/deps/react.js"), ORIGIN)
    ).toBe("passthrough");
    expect(classifyRequest({ url: "not a url", method: "GET" }, ORIGIN)).toBe(
      "passthrough"
    );
  });
});

describe("precache list", () => {
  it("always starts with the shell document and never includes the worker", () => {
    const urls = precacheUrls({
      version: "abc",
      assets: [
        "/assets/a.js",
        "assets/a.js",
        "/book-sw.js",
        "/index.html",
        "/icons/i.png",
      ],
    });
    expect(urls).toEqual(["/", "/assets/a.js", "/icons/i.png"]);
  });

  it("rebuilds redirected responses so they can answer navigations", async () => {
    const plain = new Response("shell", {
      status: 200,
      headers: { "x-a": "1" },
    });
    expect(storableResponse(plain)).toBe(plain);
    const redirected = Object.defineProperty(
      new Response("shell", { status: 200, headers: { "x-a": "1" } }),
      "redirected",
      { value: true }
    );
    const rebuilt = storableResponse(redirected);
    expect(rebuilt).not.toBe(redirected);
    expect(rebuilt.redirected).toBe(false);
    expect(rebuilt.headers.get("x-a")).toBe("1");
    expect(await rebuilt.text()).toBe("shell");
  });

  it("names caches by version and recognises its own caches", () => {
    expect(shellCacheName("deadbeef")).toBe("leaflet-shell-deadbeef");
    expect(isShellCache("leaflet-shell-deadbeef")).toBe(true);
    expect(isShellCache("leaflet-books")).toBe(false);
  });
});

describe("cache admission", () => {
  it("only caches complete same-origin successes", () => {
    expect(isCacheableResponse({ ok: true, status: 200, type: "basic" })).toBe(
      true
    );
    expect(
      isCacheableResponse({ ok: true, status: 200, type: "default" })
    ).toBe(true);
    expect(isCacheableResponse({ ok: true, status: 206, type: "basic" })).toBe(
      false
    );
    expect(isCacheableResponse({ ok: false, status: 404, type: "basic" })).toBe(
      false
    );
    expect(isCacheableResponse({ ok: true, status: 200, type: "opaque" })).toBe(
      false
    );
  });
});

describe("shareTargetFiles", () => {
  it("keeps EPUBs by type or extension and drops everything else", () => {
    const epub = new File(["x"], "book.epub", { type: "application/epub+zip" });
    const byName = new File(["x"], "Book.EPUB", { type: "" });
    const pdf = new File(["x"], "paper.pdf", { type: "application/pdf" });
    expect(shareTargetFiles([epub, "text", byName, pdf])).toEqual([
      epub,
      byName,
    ]);
  });
});
