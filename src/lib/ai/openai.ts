/**
 * OpenAI-compatible chat client (Ollama, LM Studio, OpenAI, OpenRouter, ...).
 *
 * Port of the Rust `reader-ai` crate on top of `fetch`. The browser adds one
 * boundary Rust did not have: CORS. A local server such as Ollama must allow
 * the app origin (for Ollama, `OLLAMA_ORIGINS`), otherwise the request never
 * leaves the browser and surfaces here as a network error.
 */

import type {
  ChatEvent,
  ChatRequest,
  Model,
  ProviderConfig,
} from "@/lib/types";
import { ProviderError } from "./errors";
import { validateProviderUrl } from "./provider-url";

const MAX_MESSAGES = 48;
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_ERROR_CHARS = 500;

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

function endpoint(provider: ProviderConfig, path: string): URL {
  const base = validateProviderUrl(provider.baseUrl, provider.allowRemote);
  return new URL(path, base);
}

function headers(provider: ProviderConfig, json: boolean): Headers {
  const result = new Headers();
  if (json) {
    result.set("Content-Type", "application/json");
  }
  const key = provider.apiKey?.trim();
  if (key) {
    result.set("Authorization", `Bearer ${key}`);
  }
  return result;
}

async function checkedResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  let message = "provider returned no error body";
  try {
    const body = await response.text();
    if (body) {
      message = [...body].slice(0, MAX_ERROR_CHARS).join("");
    }
  } catch {
    // Keep the default message.
  }
  throw new ProviderError(
    "provider",
    `the provider returned HTTP ${response.status}: ${message}`,
    response.status
  );
}

export function validateChat(request: ChatRequest): void {
  if (!request.model.trim()) {
    throw new ProviderError("missing_model", "a model must be selected");
  }
  const total = request.messages.reduce(
    (sum, message) => sum + byteLength(message.content),
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

interface ModelList {
  data?: unknown;
}

function isModelList(
  value: unknown
): value is { data: Record<string, unknown>[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ModelList).data)
  );
}

export async function listModels(provider: ProviderConfig): Promise<Model[]> {
  const url = endpoint(provider, "models");
  const response = await checkedResponse(
    await fetch(url, {
      method: "GET",
      headers: headers(provider, false),
      redirect: "error",
    })
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ProviderError(
      "invalid_response",
      `the provider returned an invalid response: ${String(error)}`
    );
  }
  if (!isModelList(payload)) {
    throw new ProviderError(
      "invalid_response",
      "the provider returned an invalid response: missing model list"
    );
  }
  return payload.data.flatMap((entry) => {
    if (typeof entry.id !== "string") {
      return [];
    }
    return [
      {
        id: entry.id,
        ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : null,
      },
    ];
  });
}

/**
 * Consume one SSE line. Returns `true` once the `[DONE]` sentinel has been
 * seen; the caller must stop reading at that point.
 */
export function consumeSseLine(
  rawLine: string,
  send: (event: ChatEvent) => void
): boolean {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) {
    return false;
  }
  const data = line.slice("data:".length).trim();
  if (data === "[DONE]") {
    send({ type: "done" });
    return true;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (error) {
    throw new ProviderError(
      "invalid_response",
      `the provider returned an invalid response: ${String(error)}`
    );
  }
  const content = deltaContent(value);
  if (content) {
    send({ type: "delta", content });
  }
  return false;
}

function deltaContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const first: unknown = choices[0];
  if (typeof first !== "object" || first === null) {
    return null;
  }
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) {
    return null;
  }
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

export async function streamChat(
  request: ChatRequest,
  receive: (event: ChatEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  validateChat(request);
  const url = endpoint(request.provider, "chat/completions");
  const temperature = Math.min(2, Math.max(0, request.temperature ?? 0.2));
  const response = await checkedResponse(
    await fetch(url, {
      method: "POST",
      headers: headers(request.provider, true),
      redirect: "error",
      signal,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature,
        stream: true,
      }),
    })
  );
  if (!response.body) {
    throw new ProviderError(
      "invalid_response",
      "the provider returned an invalid response: empty body"
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let lineEnd = buffer.indexOf("\n");
      while (lineEnd >= 0) {
        const line = buffer.slice(0, lineEnd + 1);
        buffer = buffer.slice(lineEnd + 1);
        if (consumeSseLine(line, receive)) {
          return;
        }
        lineEnd = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && consumeSseLine(buffer, receive)) {
      return;
    }
    receive({ type: "done" });
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
