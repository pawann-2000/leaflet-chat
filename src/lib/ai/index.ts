// biome-ignore-all lint/performance/noBarrelFile: this is the module's single public entry point.
import type {
  ChatEvent,
  ChatRequest,
  Model,
  ProviderConfig,
  ProviderKind,
} from "@/lib/types";
import { ProviderError } from "./errors";

export { ProviderError, type ProviderErrorCode } from "./errors";
export { validateProviderUrl } from "./provider-url";

export interface ProviderPreset {
  allowRemote: boolean;
  baseUrl: string;
  id: string;
  kind: ProviderKind;
  name: string;
  needsKey: boolean;
  note?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    allowRemote: false,
    needsKey: false,
    note: "Ollama must allow this site: set OLLAMA_ORIGINS to include the app origin.",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    allowRemote: false,
    needsKey: false,
  },
  {
    id: "openai",
    name: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    allowRemote: true,
    needsKey: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    allowRemote: true,
    needsKey: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    allowRemote: true,
    needsKey: true,
  },
  {
    id: "custom",
    name: "OpenAI compatible",
    kind: "openai-compatible",
    baseUrl: "",
    allowRemote: true,
    needsKey: false,
  },
];

/** Presets whose endpoints refuse unauthenticated calls. */
const KEY_REQUIRED_HOSTS = new Set(
  PROVIDER_PRESETS.filter((preset) => preset.needsKey).map(
    (preset) => new URL(preset.baseUrl).host
  )
);

function requireKey(provider: ProviderConfig): void {
  if (provider.apiKey?.trim()) {
    return;
  }
  let host: string;
  try {
    host = new URL(provider.baseUrl).host;
  } catch {
    return; // URL errors surface from validateProviderUrl with a better message.
  }
  if (provider.kind === "anthropic" || KEY_REQUIRED_HOSTS.has(host)) {
    throw new ProviderError(
      "missing_key",
      `${provider.name || "This provider"} needs an API key`
    );
  }
}

// Adapters load on first use so the Anthropic SDK stays out of the initial
// bundle for users who never pick that provider.
async function adapter(kind: ProviderKind) {
  switch (kind) {
    case "openai-compatible":
      return await import("./openai");
    case "anthropic":
      return await import("./anthropic");
    default:
      throw new ProviderError(
        "unsupported_provider",
        `unsupported provider kind ${String(kind)}`
      );
  }
}

export async function listModels(provider: ProviderConfig): Promise<Model[]> {
  requireKey(provider);
  const { listModels: list } = await adapter(provider.kind);
  return list(provider);
}

export async function streamChat(
  request: ChatRequest,
  receive: (event: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  requireKey(request.provider);
  const { streamChat: stream } = await adapter(request.provider.kind);
  return stream(request, receive, signal);
}
