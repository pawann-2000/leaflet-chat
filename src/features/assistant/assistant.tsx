import { ArrowUpRight, RotateCcw, Settings2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Message,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
  MessageHeader,
  MessageScroller,
  MessageTyping,
} from "@/components/agents/message";
import { PromptInput } from "@/components/agents/prompt-input";
import { Button, StatefulButton } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Switch } from "@/components/motion/switch";
import { PROVIDER_PRESETS, type ProviderPreset } from "@/lib/ai";
import { errorMessage } from "@/lib/errors";
import { platform } from "@/lib/platform";
import type { ChatMessage, Model, ProviderConfig } from "@/lib/types";

interface DisplayMessage {
  content: string;
  error?: string;
  id: number;
  role: "user" | "assistant";
}

const SUGGESTIONS = [
  "Explain the subtext",
  "Summarize in three lines",
  "What should I notice?",
];
const CONTEXT_LIMIT = 16_000;
const DEFAULT_PRESET = "ollama";
const PREFERRED_MODEL = "claude-opus-5";

function presetFor(id: string): ProviderPreset {
  return (
    PROVIDER_PRESETS.find((preset) => preset.id === id) ?? PROVIDER_PRESETS[0]
  );
}

function configFromPreset(
  id: string,
  previous?: ProviderConfig
): ProviderConfig {
  const preset = presetFor(id);
  return {
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl || previous?.baseUrl || "",
    apiKey: null,
    allowRemote: preset.allowRemote,
  };
}

/** Match a stored config back to the preset it came from. */
function presetOf(config: ProviderConfig): string {
  return (
    PROVIDER_PRESETS.find(
      (preset) => preset.name === config.name && preset.kind === config.kind
    )?.id ?? "custom"
  );
}

function ProviderSetup({
  canStore,
  connecting,
  locked,
  onChoose,
  onConfigure,
  onConnect,
  onToggleRemember,
  presetId,
  presets,
  provider,
  remember,
  status,
}: {
  canStore: boolean;
  connecting: boolean;
  locked: boolean;
  onChoose: (id: string) => void;
  onConfigure: (change: Partial<ProviderConfig>) => void;
  onConnect: () => void;
  onToggleRemember: (next: boolean) => void;
  presetId: string;
  presets: ProviderPreset[];
  provider: ProviderConfig;
  remember: boolean;
  status: string;
}) {
  const preset = presetFor(presetId);
  const custom = presetId === "custom";
  const wantsKey = preset.needsKey || custom;

  return (
    <div className="flex shrink-0 flex-col gap-3 rounded-2xl border border-border p-3">
      <Select disabled={locked} onValueChange={onChoose} value={presetId}>
        <SelectTrigger>
          <SelectValue placeholder="Provider" />
        </SelectTrigger>
        <SelectContent>
          {presets.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        disabled={locked}
        label="Base URL"
        onChange={(baseUrl) => onConfigure({ baseUrl })}
        spellCheck={false}
        type="url"
        value={provider.baseUrl}
      />
      {wantsKey && (
        <Input
          autoComplete="off"
          disabled={locked}
          label="API key"
          onChange={(apiKey) => onConfigure({ apiKey })}
          placeholder={canStore ? "Your own key" : "Kept in memory only"}
          type="password"
          value={provider.apiKey ?? ""}
        />
      )}
      {canStore && wantsKey && (
        <Switch
          checked={remember}
          disabled={locked}
          label="Remember the key on this device"
          onCheckedChange={onToggleRemember}
        />
      )}
      {custom && (
        <Switch
          checked={provider.allowRemote}
          disabled={locked}
          label="Allow a non-local endpoint"
          onCheckedChange={(allowRemote) => onConfigure({ allowRemote })}
        />
      )}
      {preset.note && (
        <p className="text-muted-foreground text-xs">{preset.note}</p>
      )}
      <StatefulButton
        disabled={locked || !provider.baseUrl.trim()}
        loadingText="Connecting…"
        onClick={onConnect}
        size="sm"
        state={connecting ? "loading" : "idle"}
      >
        Find models
      </StatefulButton>
      <p className="break-words text-muted-foreground text-xs" role="status">
        {status}
      </p>
    </div>
  );
}

export function Assistant({
  selectedText,
  chapterText,
  chapterTitle,
  onError,
}: {
  selectedText: string;
  chapterText: string;
  chapterTitle: string;
  onError: (message: string) => void;
}) {
  const host = platform();
  const presets = PROVIDER_PRESETS.filter((preset) =>
    host.capabilities.providers.includes(preset.kind)
  );
  const [presetId, setPresetId] = useState(DEFAULT_PRESET);
  const [provider, setProvider] = useState<ProviderConfig>(() =>
    configFromPreset(DEFAULT_PRESET)
  );
  const [remember, setRemember] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [setup, setSetup] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Not connected");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const nextId = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const context = (selectedText || chapterText).slice(0, CONTEXT_LIMIT);
  const locked = connecting || busy;
  const canStore =
    host.capabilities.storedKeys && Boolean(host.saveProviderConfig);

  useEffect(() => {
    if (!host.loadProviderConfig) {
      return;
    }
    host
      .loadProviderConfig()
      .then((stored) => {
        if (!stored) {
          return;
        }
        setPresetId(presetOf(stored));
        setProvider(stored);
        setRemember(Boolean(stored.apiKey));
      })
      .catch((error: unknown) => onError(errorMessage(error)));
  }, [host, onError]);

  useEffect(() => () => abort.current?.abort(), []);

  function reset() {
    setModels([]);
    setModel("");
    setStatus("Not connected");
  }

  function choose(next: string) {
    setPresetId(next);
    setProvider((current) => configFromPreset(next, current));
    reset();
  }

  function configure(change: Partial<ProviderConfig>) {
    setProvider((current) => ({ ...current, ...change }));
    reset();
  }

  const requestProvider = (): ProviderConfig => ({
    ...provider,
    apiKey: provider.apiKey?.trim() || null,
  });

  async function persist(config: ProviderConfig, keepKey: boolean) {
    if (!(canStore && host.saveProviderConfig)) {
      return;
    }
    await host.saveProviderConfig({
      ...config,
      apiKey: keepKey ? config.apiKey : null,
    });
  }

  async function connect() {
    setConnecting(true);
    setStatus("Checking endpoint…");
    try {
      const config = requestProvider();
      const found = await host.listModels(config);
      const preferred =
        found.find((item) => item.id === PREFERRED_MODEL)?.id ??
        found[0]?.id ??
        "";
      setModels(found);
      setModel(preferred);
      setStatus(
        found.length
          ? `${found.length} model${found.length === 1 ? "" : "s"} ready`
          : "No loaded models"
      );
      setSetup(!found.length);
      await persist(config, remember);
    } catch (error) {
      const message = errorMessage(error);
      setStatus(message);
      onError(message);
    } finally {
      setConnecting(false);
    }
  }

  async function toggleRemember(next: boolean) {
    setRemember(next);
    try {
      await persist(requestProvider(), next);
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  function stop() {
    abort.current?.abort();
  }

  async function ask(question: string) {
    if (busy || !model) {
      return;
    }
    const userId = nextId.current++;
    const responseId = nextId.current++;
    const history: ChatMessage[] = [
      ...messages.map(({ role, content }) => ({ role, content })),
      { role: "user", content: question },
    ];
    const contextLabel = selectedText
      ? "the reader selection"
      : `the current chapter, “${chapterTitle}”`;
    const update = (change: (message: DisplayMessage) => DisplayMessage) =>
      setMessages((current) =>
        current.map((message) =>
          message.id === responseId ? change(message) : message
        )
      );
    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content: question },
      { id: responseId, role: "assistant", content: "" },
    ]);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      await host.streamChat(
        {
          provider: requestProvider(),
          model,
          temperature: 0.2,
          messages: [
            {
              role: "system",
              content: `Answer using only ${contextLabel} below. Say when the context is insufficient. Be concise.\n\n<context>\n${context}\n</context>`,
            },
            ...history,
          ],
        },
        (event) => {
          if (event.type === "delta") {
            update((message) => ({
              ...message,
              content: message.content + event.content,
            }));
          }
        },
        controller.signal
      );
    } catch (error) {
      if (!controller.signal.aborted) {
        update((message) => ({
          ...message,
          error: `Could not complete the request: ${errorMessage(error)}`,
        }));
      }
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="eyebrow">Margin notes</p>
          <p className="truncate font-medium text-sm">
            {model ? provider.name : "Ask a model"}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            aria-label="New conversation"
            disabled={locked || !messages.length}
            onClick={() => setMessages([])}
            size="icon"
            variant="ghost"
          >
            <RotateCcw className="size-4" />
          </Button>
          <Button
            aria-expanded={setup || !model}
            aria-label="Model settings"
            onClick={() => setSetup((current) => !current)}
            size="icon"
            variant="ghost"
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>

      {(setup || !model) && (
        <ProviderSetup
          canStore={canStore}
          connecting={connecting}
          locked={locked}
          onChoose={choose}
          onConfigure={configure}
          onConnect={connect}
          onToggleRemember={toggleRemember}
          presetId={presetId}
          presets={presets}
          provider={provider}
          remember={remember}
          status={status}
        />
      )}

      {selectedText && (
        <div className="shrink-0 rounded-xl bg-muted/60 px-3 py-2 text-xs">
          <p className="font-medium">Selected passage</p>
          <p className="mt-1 line-clamp-3 text-muted-foreground">
            “{selectedText}”
          </p>
        </div>
      )}

      <MessageScroller
        busy={busy}
        className="min-h-24 flex-1"
        contentClassName="flex flex-col gap-4 py-1"
        label="Reading conversation"
      >
        {messages.length ? (
          messages.map((message) => (
            <Message animateIn from={message.role} key={message.id}>
              <MessageContent>
                <MessageHeader>
                  {message.role === "user" ? "You" : "Leaflet"}
                </MessageHeader>
                <MessageBubble
                  variant={message.role === "user" ? "soft" : "ghost"}
                >
                  <MessageBubbleContent className="whitespace-pre-wrap break-words">
                    {message.content ||
                      (busy && !message.error ? <MessageTyping /> : null)}
                    {message.error && (
                      <p className="mt-2 text-destructive text-xs" role="alert">
                        {message.error}
                      </p>
                    )}
                  </MessageBubbleContent>
                </MessageBubble>
              </MessageContent>
            </Message>
          ))
        ) : (
          <div className="flex flex-col gap-2 py-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <p className="text-muted-foreground text-sm">
              {selectedText
                ? "Ask about your selection"
                : "Select a passage, or ask about this chapter"}
            </p>
            {SUGGESTIONS.map((suggestion) => (
              <Button
                className="justify-between"
                key={suggestion}
                onClick={() => setPrompt(suggestion)}
                size="sm"
                variant="outline"
              >
                {suggestion}
                <ArrowUpRight className="size-3.5" />
              </Button>
            ))}
          </div>
        )}
      </MessageScroller>

      <div className="shrink-0">
        <PromptInput
          aria-label="Ask about the text"
          disabled={!model}
          loading={busy}
          model={model}
          models={models.map(({ id }) => ({ value: id, label: id }))}
          onModelChange={setModel}
          onStop={stop}
          onSubmit={ask}
          onValueChange={setPrompt}
          placeholder={
            model ? "Ask about the text…" : "Connect a model to begin"
          }
          value={prompt}
        />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          Context goes directly from this browser to your chosen model.
        </p>
      </div>
    </div>
  );
}
