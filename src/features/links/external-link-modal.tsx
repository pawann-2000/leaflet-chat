import { useEffect } from "react";
import { Button, StatefulButton } from "@/components/motion/button";
import { MorphingModal } from "@/components/motion/morphing-modal";
import type { ExternalOpenMode, LinkTarget } from "@/lib/types";

export type ExternalTarget = Extract<LinkTarget, { kind: "external" }>;

function linkKind(url?: string): string {
  return url?.startsWith("mailto:") ? "Email link" : "External application";
}

export function ExternalLinkModal({
  target,
  busy,
  onCancel,
  onOpen,
}: {
  target: ExternalTarget | null;
  busy: boolean;
  onCancel: () => void;
  onOpen: (mode: ExternalOpenMode) => void;
}) {
  useEffect(() => {
    if (!target) {
      return;
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [target, busy, onCancel]);

  const destination = target?.origin
    ? new URL(target.origin).host
    : linkKind(target?.url);

  return (
    <MorphingModal
      className="max-w-md"
      onClose={() => !busy && onCancel()}
      placement="center"
      viewId={target ? "external" : null}
    >
      {target && (
        <div className="flex flex-col gap-4">
          <div>
            <p className="eyebrow">Leaving the book</p>
            <h2 className="mt-1 font-semibold text-lg">Open external link?</h2>
          </div>
          <p className="text-muted-foreground text-sm">
            This destination will open in your default application. Leaflet does
            not load external pages inside the reader.
          </p>
          <div className="rounded-xl bg-muted/70 p-3">
            <p className="break-all font-medium text-sm">{target.url}</p>
            <p className="mt-1 text-muted-foreground text-xs">{destination}</p>
          </div>
          <p className="text-muted-foreground text-xs">
            {target.origin
              ? "Trusting this site skips this prompt for future links from any book. You can revoke access in Trusted sites."
              : "This link type cannot be permanently trusted."}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={busy}
              onClick={onCancel}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => onOpen("once")}
              size="sm"
              variant="outline"
            >
              Open once
            </Button>
            {target.origin && (
              <StatefulButton
                disabled={busy}
                loadingText="Opening…"
                onClick={() => onOpen("trust")}
                size="sm"
                state={busy ? "loading" : "idle"}
              >
                Trust this site & open
              </StatefulButton>
            )}
          </div>
        </div>
      )}
    </MorphingModal>
  );
}
