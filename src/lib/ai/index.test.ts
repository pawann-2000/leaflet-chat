import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "@/lib/types";
import {
  listModels,
  PROVIDER_PRESETS,
  ProviderError,
  streamChat,
} from "./index";

const fromPreset = (
  id: string,
  apiKey: string | null = null
): ProviderConfig => {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`missing preset ${id}`);
  }
  return {
    name: preset.name,
    baseUrl: preset.baseUrl,
    kind: preset.kind,
    allowRemote: preset.allowRemote,
    apiKey,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dispatcher", () => {
  it("lists every preset once", () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "ollama",
      "lmstudio",
      "openai",
      "openrouter",
      "anthropic",
      "custom",
    ]);
  });

  it("refuses key-requiring presets without a key before any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const id of ["openai", "openrouter", "anthropic"]) {
      const error = await listModels(fromPreset(id)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).code).toBe("missing_key");
    }
    const chat = await streamChat(
      {
        provider: fromPreset("anthropic", "  "),
        model: "m",
        temperature: null,
        messages: [{ role: "user", content: "x" }],
      },
      () => undefined
    ).catch((e: unknown) => e);
    expect((chat as ProviderError).code).toBe("missing_key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets keyless local presets through to the openai client", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "llama" }] }), {
          status: 200,
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await listModels(fromPreset("ollama"))).toEqual([
      { id: "llama", ownedBy: null },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
