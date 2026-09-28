import { useCallback, useState } from "react";
import type { ExternalTarget } from "@/features/links/external-link-modal";
import type { Platform } from "@/lib/platform";
import type { ExternalOpenMode, TrustedSite } from "@/lib/types";

/** Confirmation flow for links that leave the book, plus the trusted-sites list. */
export function useExternalLinks(
  host: Platform,
  onError: (error: unknown) => void
) {
  const [pending, setPending] = useState<ExternalTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [trustedOpen, setTrustedOpen] = useState(false);
  const [trustedSites, setTrustedSites] = useState<TrustedSite[]>([]);
  const [trustedBusy, setTrustedBusy] = useState(false);

  const refreshTrusted = useCallback(async () => {
    setTrustedBusy(true);
    try {
      setTrustedSites(await host.listTrustedSites());
    } catch (error) {
      onError(error);
    } finally {
      setTrustedBusy(false);
    }
  }, [host, onError]);

  const confirm = useCallback(
    async (mode: ExternalOpenMode) => {
      if (!pending) {
        return;
      }
      setBusy(true);
      try {
        await host.openExternalLink(pending.requestId, mode);
        setPending(null);
        if (mode === "trust") {
          await refreshTrusted();
        }
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    },
    [host, onError, pending, refreshTrusted]
  );

  const openTrusted = useCallback(async () => {
    setTrustedOpen(true);
    setPending(null);
    await refreshTrusted();
  }, [refreshTrusted]);

  const revoke = useCallback(
    async (origin: string | null) => {
      setTrustedBusy(true);
      try {
        if (origin === null) {
          await host.revokeAllTrustedSites();
        } else {
          await host.revokeTrustedSite(origin);
        }
        setTrustedSites((sites) =>
          origin === null ? [] : sites.filter((site) => site.origin !== origin)
        );
      } catch (error) {
        onError(error);
      } finally {
        setTrustedBusy(false);
      }
    },
    [host, onError]
  );

  return {
    pending,
    setPending,
    busy,
    confirm,
    trustedOpen,
    closeTrusted: () => setTrustedOpen(false),
    openTrusted,
    trustedSites,
    trustedBusy,
    revoke,
  };
}
