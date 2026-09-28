import { Shield, X } from "lucide-react";
import { Button } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { Loader } from "@/components/motion/loader";
import type { TrustedSite } from "@/lib/types";

const date = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function TrustedSitesDrawer({
  open,
  sites,
  busy,
  onClose,
  onRevoke,
  onRevokeAll,
}: {
  open: boolean;
  sites: TrustedSite[];
  busy: boolean;
  onClose: () => void;
  onRevoke: (origin: string) => void;
  onRevokeAll: () => void;
}) {
  return (
    <Drawer
      ariaLabel="Trusted sites"
      className="w-96"
      onOpenChange={(next) => !next && onClose()}
      open={open}
      side="right"
    >
      <div className="flex items-start justify-between gap-3 border-border border-b p-4">
        <div>
          <p className="eyebrow">Privacy & security</p>
          <h2 className="mt-1 font-semibold text-lg">Trusted sites</h2>
        </div>
        <Button
          aria-label="Close"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </div>
      <p className="px-4 pt-4 text-muted-foreground text-sm">
        Links to these sites open directly in your default browser. Every other
        external destination asks first.
      </p>
      <div className="flex items-center justify-between px-4 py-3 text-muted-foreground text-xs">
        <span>
          {sites.length} trusted {sites.length === 1 ? "site" : "sites"}
        </span>
        {sites.length > 0 && (
          <Button
            disabled={busy}
            onClick={onRevokeAll}
            size="sm"
            variant="outline"
          >
            Revoke all
          </Button>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-4">
        {sites.map((site) => (
          <li
            className="flex items-center gap-3 border-border border-t py-3"
            key={site.origin}
          >
            <Shield className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">{site.origin}</p>
              <p className="text-muted-foreground text-xs">
                Trusted {date.format(new Date(site.trustedAt * 1000))}
              </p>
            </div>
            <Button
              disabled={busy}
              onClick={() => onRevoke(site.origin)}
              size="sm"
              variant="ghost"
            >
              Revoke
            </Button>
          </li>
        ))}
        {sites.length === 0 && (
          <li
            aria-live="polite"
            className="flex flex-col items-center gap-2 py-10 text-center"
          >
            {busy ? (
              <Loader label="Loading trusted sites" variant="dots" />
            ) : (
              <>
                <p className="font-medium text-sm">No trusted sites</p>
                <p className="text-muted-foreground text-xs">
                  When you trust an external link, its site will appear here.
                </p>
              </>
            )}
          </li>
        )}
      </ul>
      <p className="border-border border-t p-4 text-muted-foreground text-xs">
        Trust only affects link confirmation. External content is never loaded
        inside the reader.
      </p>
    </Drawer>
  );
}
