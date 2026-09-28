import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Platform } from "@/lib/platform/types";
import type {
  Chapter,
  ChatEvent,
  ChatRequest,
  ExternalOpenMode,
  LinkTarget,
  Model,
  OpenedPublication,
  ProviderConfig,
  TrustedSite,
} from "@/lib/types";

/** Desktop host: every operation is a Rust command behind Tauri IPC. */
export function createTauriPlatform(): Platform {
  return {
    kind: "desktop",
    capabilities: {
      library: false,
      providers: ["openai-compatible"],
      storedKeys: false,
      sync: false,
    },

    async chooseAndOpenBook() {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "EPUB publication", extensions: ["epub"] }],
      });
      if (!selected || Array.isArray(selected)) {
        return null;
      }
      return invoke<OpenedPublication>("open_book", { path: selected });
    },

    loadChapter(bookId, index) {
      return invoke<Chapter>("read_chapter", { bookId, index });
    },

    saveProgress(bookId, chapterIndex, progress) {
      return invoke("save_progress", { bookId, chapterIndex, progress });
    },

    resolveBookLink(bookId, href) {
      return invoke<LinkTarget>("resolve_book_link", { bookId, href });
    },
    openExternalLink(requestId: string, mode: ExternalOpenMode) {
      return invoke("open_external_link", { requestId, mode });
    },
    listTrustedSites() {
      return invoke<TrustedSite[]>("trusted_sites");
    },
    revokeTrustedSite(origin) {
      return invoke("revoke_trusted_site", { origin });
    },
    revokeAllTrustedSites() {
      return invoke("revoke_all_trusted_sites");
    },

    listModels(provider: ProviderConfig) {
      return invoke<Model[]>("list_models", {
        provider: wireProvider(provider),
      });
    },
    async streamChat(request: ChatRequest, receive) {
      const onEvent = new Channel<ChatEvent>();
      onEvent.onmessage = receive;
      await invoke("stream_chat", {
        request: { ...request, provider: wireProvider(request.provider) },
        onEvent,
      });
    },
  };
}

/** The Rust `ProviderConfig` has no `kind`; only OpenAI-compatible endpoints reach it. */
function wireProvider(provider: ProviderConfig) {
  if (provider.kind !== "openai-compatible") {
    throw new Error(
      "The desktop app only supports OpenAI-compatible providers."
    );
  }
  const { kind: _kind, ...wire } = provider;
  return wire;
}

/** Desktop diagnostics used by the link-navigation test harness. */
export function diagnosticLinkConfig(): Promise<{
  path: string;
  linkIndex: number;
} | null> {
  return invoke("diagnostic_link_config");
}

export function openBookPath(path: string): Promise<OpenedPublication> {
  return invoke("open_book", { path });
}
