/**
 * Anthropic adapter on the official SDK.
 *
 * The key never leaves the browser except in the request to the configured
 * base URL, which is why `dangerouslyAllowBrowser` is set: this is a
 * bring-your-own-key app and the key belongs to the person at the keyboard.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type {
  ChatEvent,
  ChatRequest,
  Model,
  ProviderConfig,
} from "@/lib/types";
import { ProviderError } from "./errors";
import { validateProviderUrl } from "./provider-url";

const MAX_OUTPUT_TOKENS = 16_000;
// Same local safety limits as the OpenAI-compatible adapter (and the Rust
// `reader-ai` crate). Kept here rather than imported from `./openai` so the
// two adapters stay in separate lazy chunks: a static import would pull the
// whole OpenAI client into the Anthropic bundle and defeat the code split.
const MAX_MESSAGES = 48;
const MAX_MESSAGE_BYTES = 128 * 1024;

function validateChat(request: ChatRequest): void {
  if (!request.model.trim()) {
    throw new ProviderError("missing_model", "a model must be selected");
  }
  const encoder = new TextEncoder();
  const total = request.messages.reduce(
    (sum, message) => sum + encoder.encode(message.content).length,
    0
  );
  if (
    request.messages.length === 0 ||
    request.messages.length > MAX_MESSAGES ||
    total > MAX_MESSAGE_BYTES
  ) {
    throw new ProviderError(
      "request_too_large",
      "the chat request exceeds the local safety limits"
    );
  }
}

/** The slice of the SDK client these adapters use; tests substitute a fake. */
export interface AnthropicClientLike {
  messages: {
    stream: (
      params: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: MessageParam[];
      },
      options?: { signal?: AbortSignal }
    ) => AnthropicStreamLike;
  };
  models: {
    list: () => AsyncIterable<{ id: string }>;
  };
}

export interface AnthropicStreamLike {
  finalMessage(): Promise<{
    stop_reason: string | null;
    stop_details?: { explanation?: string | null } | null;
  }>;
  on(event: "text", listener: (text: string) => void): unknown;
}

const TRAILING_SLASHES = /\/+$/u;

export function createAnthropicClient(
  provider: ProviderConfig
): AnthropicClientLike {
  const base = validateProviderUrl(provider.baseUrl, provider.allowRemote);
  const client = new Anthropic({
    apiKey: provider.apiKey?.trim() ?? undefined,
    baseURL: base.toString().replace(TRAILING_SLASHES, ""),
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
  });
  return client as unknown as AnthropicClientLike;
}

export function mapAnthropicError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ProviderError("unauthorized", "the API key was rejected", 401);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError(
      "rate_limited",
      "the provider is rate limiting requests",
      429
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError(
      "network",
      `could not reach the provider: ${error.message}`
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderError(
      "provider",
      `the provider returned HTTP ${error.status ?? "?"}: ${error.message}`,
      error.status
    );
  }
  if (error instanceof Error) {
    return new ProviderError("provider", error.message);
  }
  return new ProviderError("provider", "the provider request failed");
}

export async function listModels(
  provider: ProviderConfig,
  client: AnthropicClientLike = createAnthropicClient(provider)
): Promise<Model[]> {
  const models: Model[] = [];
  try {
    for await (const info of client.models.list()) {
      models.push({ id: info.id, ownedBy: "anthropic" });
    }
  } catch (error) {
    throw mapAnthropicError(error);
  }
  return models;
}

/** Split system text out of the transcript; the API takes it as a top-level field. */
export function splitSystem(request: ChatRequest): {
  system: string | undefined;
  messages: MessageParam[];
} {
  const system: string[] = [];
  const messages: MessageParam[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(message.content);
    } else {
      messages.push({ role: message.role, content: message.content });
    }
  }
  return {
    system: system.length ? system.join("\n\n") : undefined,
    messages,
  };
}

export async function streamChat(
  request: ChatRequest,
  receive: (event: ChatEvent) => void,
  signal?: AbortSignal,
  client: AnthropicClientLike = createAnthropicClient(request.provider)
): Promise<void> {
  validateChat(request);
  const { system, messages } = splitSystem(request);
  if (messages.length === 0) {
    throw new ProviderError(
      "request_too_large",
      "the chat request exceeds the local safety limits"
    );
  }
  try {
    const stream = client.messages.stream(
      {
        model: request.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(system ? { system } : {}),
        messages,
      },
      signal ? { signal } : undefined
    );
    stream.on("text", (text) => {
      if (text) {
        receive({ type: "delta", content: text });
      }
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      const explanation = final.stop_details?.explanation;
      receive({
        type: "delta",
        content: explanation
          ? `\n\n[The model declined this request: ${explanation}]`
          : "\n\n[The model declined this request.]",
      });
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw mapAnthropicError(error);
  }
  receive({ type: "done" });
}
