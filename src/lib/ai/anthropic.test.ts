import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { ChatEvent, ChatRequest, ProviderConfig } from "@/lib/types";
import {
  type AnthropicClientLike,
  type AnthropicStreamLike,
  listModels,
  mapAnthropicError,
  splitSystem,
  streamChat,
} from "./anthropic";
import type { ProviderError } from "./errors";

const provider: ProviderConfig = {
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKey: "sk-test",
  allowRemote: true,
  kind: "anthropic",
};

const request: ChatRequest = {
  provider,
  model: "claude-opus-5",
  temperature: 0.2,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "Again" },
  ],
};

interface FakeStreamOptions {
  explanation?: string | null;
  stopReason?: string | null;
  texts?: string[];
}

function fakeClient(options: FakeStreamOptions = {}) {
  const calls: Array<{ params: unknown; options: unknown }> = [];
  const client: AnthropicClientLike = {
    messages: {
      stream(params, requestOptions) {
        calls.push({ params, options: requestOptions });
        const listeners: Array<(text: string) => void> = [];
        const stream: AnthropicStreamLike = {
          on(_event, listener) {
            listeners.push(listener);
            return stream;
          },
          finalMessage() {
            for (const text of options.texts ?? ["a", "b"]) {
              for (const listener of listeners) {
                listener(text);
              }
            }
            return Promise.resolve({
              stop_reason: options.stopReason ?? "end_turn",
              stop_details:
                options.stopReason === "refusal"
                  ? { explanation: options.explanation ?? null }
                  : null,
            });
          },
        };
        return stream;
      },
    },
    models: {
      // biome-ignore lint/suspicious/useAwait: fakes the SDK's async page iterator.
      async *list() {
        yield { id: "claude-opus-5" };
        yield { id: "claude-sonnet-5" };
      },
    },
  };
  return { client, calls };
}

describe("splitSystem", () => {
  it("lifts system messages out of the transcript", () => {
    expect(splitSystem(request)).toEqual({
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Again" },
      ],
    });
  });
});

describe("streamChat", () => {
  it("passes system separately, omits temperature and streams deltas", async () => {
    const { client, calls } = fakeClient();
    const events: ChatEvent[] = [];
    await streamChat(request, (event) => events.push(event), undefined, client);
    expect(events).toEqual([
      { type: "delta", content: "a" },
      { type: "delta", content: "b" },
      { type: "done" },
    ]);
    expect(calls[0].params).toEqual({
      model: "claude-opus-5",
      max_tokens: 16_000,
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Again" },
      ],
    });
    expect(calls[0].params).not.toHaveProperty("temperature");
  });

  it("forwards the abort signal", async () => {
    const { client, calls } = fakeClient();
    const controller = new AbortController();
    await streamChat(request, () => undefined, controller.signal, client);
    expect(calls[0].options).toEqual({ signal: controller.signal });
  });

  it("appends a note when the model refuses", async () => {
    const { client } = fakeClient({
      stopReason: "refusal",
      explanation: "policy",
      texts: [],
    });
    const events: ChatEvent[] = [];
    await streamChat(request, (event) => events.push(event), undefined, client);
    expect(events).toEqual([
      {
        type: "delta",
        content: "\n\n[The model declined this request: policy]",
      },
      { type: "done" },
    ]);
  });

  it("rejects a transcript with only system messages", async () => {
    const { client } = fakeClient();
    const error = await streamChat(
      { ...request, messages: [{ role: "system", content: "x" }] },
      () => undefined,
      undefined,
      client
    ).catch((e: unknown) => e);
    expect((error as ProviderError).code).toBe("request_too_large");
  });
});

describe("listModels", () => {
  it("maps the sdk page into models", async () => {
    const { client } = fakeClient();
    expect(await listModels(provider, client)).toEqual([
      { id: "claude-opus-5", ownedBy: "anthropic" },
      { id: "claude-sonnet-5", ownedBy: "anthropic" },
    ]);
  });
});

describe("mapAnthropicError", () => {
  it("maps sdk errors most-specific first", () => {
    const headers = new Headers();
    expect(
      mapAnthropicError(
        new Anthropic.AuthenticationError(401, {}, "bad key", headers)
      ).code
    ).toBe("unauthorized");
    expect(
      mapAnthropicError(
        new Anthropic.RateLimitError(429, {}, "slow down", headers)
      ).code
    ).toBe("rate_limited");
    expect(mapAnthropicError(new Anthropic.APIConnectionError({})).code).toBe(
      "network"
    );
    const generic = mapAnthropicError(
      new Anthropic.APIError(500, {}, "boom", headers)
    );
    expect(generic.code).toBe("provider");
    expect(generic.status).toBe(500);
    expect(mapAnthropicError(new Error("plain")).code).toBe("provider");
  });
});
