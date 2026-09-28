import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatRequest, ProviderConfig } from "@/lib/types";
import { ProviderError } from "./errors";
import { consumeSseLine, listModels, streamChat } from "./openai";

const provider: ProviderConfig = {
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: null,
  allowRemote: false,
  kind: "openai-compatible",
};

const request = (overrides: Partial<ChatRequest> = {}): ChatRequest => ({
  provider,
  model: "test-model",
  temperature: 0.2,
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

function bytesStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function sseResponse(chunks: string[], init: ResponseInit = {}): Response {
  return new Response(bytesStream(chunks), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
    ...init,
  });
}

async function collect(
  chunks: string[],
  overrides: Partial<ChatRequest> = {}
): Promise<ChatEvent[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sseResponse(chunks))
  );
  const events: ChatEvent[] = [];
  await streamChat(request(overrides), (event) => events.push(event));
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consumeSseLine", () => {
  it("parses openai stream events", () => {
    const events: ChatEvent[] = [];
    const finished = consumeSseLine(
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      (event) => events.push(event)
    );
    expect(finished).toBe(false);
    expect(events).toEqual([{ type: "delta", content: "Hello" }]);
  });

  it("recognizes the done sentinel", () => {
    const events: ChatEvent[] = [];
    expect(consumeSseLine("data: [DONE]", (event) => events.push(event))).toBe(
      true
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("ignores comments, blank lines and empty deltas", () => {
    const events: ChatEvent[] = [];
    expect(consumeSseLine(": keep-alive", (e) => events.push(e))).toBe(false);
    expect(consumeSseLine("", (e) => events.push(e))).toBe(false);
    expect(
      consumeSseLine('data: {"choices":[{"delta":{}}]}', (e) => events.push(e))
    ).toBe(false);
    expect(events).toEqual([]);
  });

  it("rejects malformed json", () => {
    expect(() => consumeSseLine("data: {nope", () => undefined)).toThrowError(
      ProviderError
    );
    try {
      consumeSseLine("data: {nope", () => undefined);
    } catch (error) {
      expect((error as ProviderError).code).toBe("invalid_response");
    }
  });
});

describe("streamChat", () => {
  it("reassembles deltas across awkward chunk boundaries", async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"con',
      'tent":"Hel"}}]}\r\ndata: {"choi',
      'ces":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n",
    ]);
    expect(events).toEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo" },
      { type: "done" },
    ]);
  });

  it("emits done when the stream ends without a sentinel", async () => {
    const events = await collect([
      'data: {"choices":[{"delta":{"content":"x"}}]}',
    ]);
    expect(events).toEqual([{ type: "delta", content: "x" }, { type: "done" }]);
  });

  it("stops reading after the sentinel", async () => {
    const events = await collect([
      "data: [DONE]\n",
      'data: {"choices":[{"delta":{"content":"late"}}]}\n',
    ]);
    expect(events).toEqual([{ type: "done" }]);
  });

  it("sends the expected request shape and bearer token", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await streamChat(
      request({
        provider: { ...provider, apiKey: " secret ", allowRemote: true },
      }),
      () => undefined
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer secret"
    );
    expect(JSON.parse(String(init.body))).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      stream: true,
    });
  });

  it("clamps temperature and defaults it", async () => {
    const fetchMock = vi.fn(async () => sseResponse(["data: [DONE]\n"]));
    vi.stubGlobal("fetch", fetchMock);
    await streamChat(request({ temperature: 9 }), () => undefined);
    await streamChat(request({ temperature: null }), () => undefined);
    const bodies = fetchMock.mock.calls.map(
      (call) =>
        JSON.parse(String((call as unknown as [URL, RequestInit])[1].body))
          .temperature
    );
    expect(bodies).toEqual([2, 0.2]);
  });

  it("maps non-2xx responses with a truncated body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(1000), { status: 503 }))
    );
    const error = await streamChat(request(), () => undefined).catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe("provider");
    expect((error as ProviderError).status).toBe(503);
    expect((error as ProviderError).message).toBe(
      `the provider returned HTTP 503: ${"x".repeat(500)}`
    );
  });

  it("rejects an empty model", async () => {
    const error = await streamChat(
      request({ model: " " }),
      () => undefined
    ).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("missing_model");
  });

  it("enforces message count and size limits", async () => {
    const many = Array.from({ length: 49 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    const tooMany = await streamChat(
      request({ messages: many }),
      () => undefined
    ).catch((e: unknown) => e);
    expect((tooMany as ProviderError).code).toBe("request_too_large");

    const big = [{ role: "user" as const, content: "é".repeat(65 * 1024) }];
    const tooBig = await streamChat(
      request({ messages: big }),
      () => undefined
    ).catch((e: unknown) => e);
    expect((tooBig as ProviderError).code).toBe("request_too_large");

    const none = await streamChat(
      request({ messages: [] }),
      () => undefined
    ).catch((e: unknown) => e);
    expect((none as ProviderError).code).toBe("request_too_large");
  });

  it("propagates aborts", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError"))
          );
        });
      })
    );
    const pending = streamChat(request(), () => undefined, controller.signal);
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("refuses remote endpoints without opt-in before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const error = await streamChat(
      request({ provider: { ...provider, baseUrl: "https://api.example/v1" } }),
      () => undefined
    ).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("remote_endpoint_denied");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listModels", () => {
  it("maps the model list and omits the auth header without a key", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "a", owned_by: "me" }, { id: "b" }, { nope: true }],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const models = await listModels(provider);
    expect(models).toEqual([
      { id: "a", ownedBy: "me" },
      { id: "b", ownedBy: null },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe("http://127.0.0.1:11434/v1/models");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
  });

  it("rejects payloads without a data array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 }))
    );
    const error = await listModels(provider).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("invalid_response");
  });
});
