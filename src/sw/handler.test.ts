import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { BookFileRecord } from "@/lib/db/types";
import { deobfuscateIdpfFont } from "@/lib/epub/idpf";
import { readZipDirectory } from "@/lib/epub/zip";
import { BOOK_RESOURCE_CSP, handleBookRequest } from "@/sw/handler";

const BOOK_ID = "c".repeat(64);
const FONT_KEY = Uint8Array.from({ length: 20 }, (_, index) => index * 7 + 3);
const FONT_BYTES = Uint8Array.from({ length: 2000 }, (_, index) => index % 251);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
const CSS = "p { color: red; }";

function fixture(): BookFileRecord {
  const obfuscated = deobfuscateIdpfFont(FONT_BYTES.slice(), FONT_KEY);
  const archive = zipSync({
    "EPUB/styles/book.css": strToU8(CSS),
    "EPUB/images/pic.png": [PNG_BYTES, { level: 0 }],
    "EPUB/fonts/serif.otf": obfuscated,
    "EPUB/fonts/locked.otf": strToU8("nope"),
    "EPUB/text/chapter.xhtml": strToU8("<html/>"),
  });
  const { entries } = readZipDirectory(archive);
  const index = (name: string) =>
    entries.findIndex((entry) => entry.name === name);
  return {
    id: BOOK_ID,
    blob: new Blob([archive]),
    entries,
    fontKey: FONT_KEY,
    resources: {
      "/EPUB/styles/book.css": {
        mediaType: "text/css",
        transform: "none",
        zipIndex: index("EPUB/styles/book.css"),
      },
      "/EPUB/images/pic.png": {
        mediaType: "image/png",
        transform: "none",
        zipIndex: index("EPUB/images/pic.png"),
      },
      "/EPUB/fonts/serif.otf": {
        mediaType: "font/otf",
        transform: "idpf-font",
        zipIndex: index("EPUB/fonts/serif.otf"),
      },
      "/EPUB/fonts/locked.otf": {
        mediaType: "font/otf",
        transform: "unsupported",
        zipIndex: index("EPUB/fonts/locked.otf"),
      },
    },
  };
}

const record = fixture();
const load = async (id: string) => (id === BOOK_ID ? record : undefined);
const url = (path: string, id = BOOK_ID) =>
  `${location.origin}/book/${id}/${path}`;

describe("handleBookRequest", () => {
  it("serves a stored resource with the protocol headers", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/styles/book.css")),
      load
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("text/css");
    expect(response?.headers.get("Cache-Control")).toBe(
      "private, max-age=31536000, immutable"
    );
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response?.headers.get("Content-Security-Policy")).toBe(
      BOOK_RESOURCE_CSP
    );
    expect(await response?.text()).toBe(CSS);
  });

  it("serves binary entries byte for byte", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/images/pic.png")),
      load
    );
    // biome-ignore lint/style/noNonNullAssertion: the status assertion above guarantees a response.
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("answers HEAD with headers and no body", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/images/pic.png"), { method: "HEAD" }),
      load
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toBe("image/png");
    // biome-ignore lint/style/noNonNullAssertion: the status assertion above guarantees a response.
    expect((await response!.arrayBuffer()).byteLength).toBe(0);
  });

  it("reverses IDPF font obfuscation", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/fonts/serif.otf")),
      load
    );
    expect(response?.status).toBe(200);
    // biome-ignore lint/style/noNonNullAssertion: the status assertion above guarantees a response.
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(FONT_BYTES);
  });

  it("refuses resources whose encryption it cannot reverse", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/fonts/locked.otf")),
      load
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(await response?.text()).toBe("");
  });

  it("refuses a font whose key is missing", async () => {
    const keyless = async () => ({ ...record, fontKey: null });
    const response = await handleBookRequest(
      new Request(url("EPUB/fonts/serif.otf")),
      keyless
    );
    expect(response?.status).toBe(404);
  });

  it("does not serve documents even when they exist in the archive", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/text/chapter.xhtml")),
      load
    );
    expect(response?.status).toBe(404);
  });

  it("returns 404 for unknown books and paths", async () => {
    expect(
      (
        await handleBookRequest(
          new Request(url("EPUB/styles/book.css", "d".repeat(64))),
          load
        )
      )?.status
    ).toBe(404);
    expect(
      (await handleBookRequest(new Request(url("EPUB/missing.css")), load))
        ?.status
    ).toBe(404);
  });

  it("returns 400 for malformed and traversal paths", async () => {
    for (const path of [
      `${location.origin}/book/not-a-hash/EPUB/a.css`,
      `${location.origin}/book/${BOOK_ID}`,
      `${location.origin}/book/${BOOK_ID}/`,
      url("EPUB//styles/book.css"),
      url("%E0%A4%A"),
    ]) {
      const response = await handleBookRequest(new Request(path), load);
      expect(response?.status, path).toBe(400);
    }
  });

  it("cannot escape the book through dot-dot segments", async () => {
    // The WHATWG URL parser collapses both "EPUB/../styles" and the encoded
    // "EPUB/%2E%2E/styles" to "styles" before the handler runs, so the request
    // lands on a path that is not a declared resource. The explicit ".." check
    // in parseBookResourcePath is defence in depth behind that.
    for (const path of [
      url("EPUB/../styles/book.css"),
      url("EPUB/%2E%2E/styles/book.css"),
    ]) {
      const response = await handleBookRequest(new Request(path), load);
      expect(response?.status, path).toBe(404);
    }
  });

  it("returns 422 when the archive entry is corrupt", async () => {
    const corrupt = async () => ({
      ...record,
      blob: new Blob([
        new Uint8Array(await record.blob.arrayBuffer()).slice(0, 40),
      ]),
    });
    const response = await handleBookRequest(
      new Request(url("EPUB/images/pic.png")),
      corrupt
    );
    expect(response?.status).toBe(422);
  });

  it("returns 500 when the store cannot be read", async () => {
    const broken = () => Promise.reject(new Error("db down"));
    const response = await handleBookRequest(
      new Request(url("EPUB/images/pic.png")),
      broken
    );
    expect(response?.status).toBe(500);
  });

  it("rejects methods other than GET and HEAD", async () => {
    const response = await handleBookRequest(
      new Request(url("EPUB/styles/book.css"), { method: "POST" }),
      load
    );
    expect(response?.status).toBe(405);
  });

  it("ignores requests outside the book protocol", async () => {
    expect(
      await handleBookRequest(
        new Request(`${location.origin}/index.html`),
        load
      )
    ).toBeNull();
    expect(
      await handleBookRequest(new Request(`${location.origin}/books/x`), load)
    ).toBeNull();
    expect(
      await handleBookRequest(
        new Request(`https://other.example/book/${BOOK_ID}/a.css`),
        load
      )
    ).toBeNull();
  });
});
