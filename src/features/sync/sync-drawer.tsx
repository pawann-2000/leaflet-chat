import {
  Camera,
  Check,
  ClipboardPaste,
  Copy,
  Link2,
  QrCode,
  RefreshCw,
  Share2,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, StatefulButton } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { openLeafletStore } from "@/lib/db";
import { errorMessage } from "@/lib/errors";
import { createSyncEngine } from "@/lib/sync";
import { createQrScanner, drawQrCode, shareCode } from "@/lib/sync/qr";
import type {
  PairedDevice,
  SyncDevice,
  SyncEngine,
  SyncEvent,
  SyncSession,
  SyncSummary,
} from "@/lib/sync/types";

type Mode = "idle" | "offer" | "answer" | "relay";
type Phase =
  | "starting"
  | "show-code"
  | "await-reply"
  | "verify"
  | "connected"
  | "complete"
  | "error";

interface SessionView {
  code: string | null;
  error: string | null;
  log: { id: number; message: string }[];
  mode: Mode;
  peer: SyncDevice | null;
  phase: Phase;
  sas: string | null;
  summary: SyncSummary | null;
  transfer: { label: string; done: number; total: number } | null;
}

const IDLE: SessionView = {
  mode: "idle",
  phase: "starting",
  code: null,
  sas: null,
  peer: null,
  transfer: null,
  summary: null,
  error: null,
  log: [],
};

const when = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

let enginePromise: Promise<SyncEngine> | null = null;
function engine(): Promise<SyncEngine> {
  enginePromise ??= openLeafletStore().then((store) => createSyncEngine(store));
  return enginePromise;
}

function summarize(summary: SyncSummary): string {
  const parts = [
    summary.booksReceived && `${summary.booksReceived} book(s) received`,
    summary.booksSent && `${summary.booksSent} book(s) sent`,
    (summary.progressReceived || summary.progressSent) &&
      "reading positions merged",
    (summary.trustedReceived || summary.trustedSent) && "trusted sites merged",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Both devices were already in sync";
}

function reduceView(current: SessionView, event: SyncEvent): SessionView {
  switch (event.type) {
    case "status":
      return {
        ...current,
        log: [
          ...current.log,
          { id: (current.log.at(-1)?.id ?? 0) + 1, message: event.message },
        ].slice(-8),
      };
    case "signal-ready":
      return {
        ...current,
        code: event.code,
        phase: event.role === "offer" ? "show-code" : "await-reply",
      };
    case "sas":
      return { ...current, sas: event.code, phase: "verify" };
    case "connected":
      return { ...current, peer: event.peer, phase: "connected" };
    case "transfer":
      return {
        ...current,
        transfer: {
          label: event.label,
          done: event.done,
          total: event.total,
        },
      };
    case "complete":
      return {
        ...current,
        phase: "complete",
        summary: event.summary,
        transfer: null,
      };
    case "error":
      return { ...current, phase: "error", error: event.message };
    default:
      return current;
  }
}

function PeerRow({
  canRelay,
  onForget,
  onSync,
  peer,
}: {
  canRelay: boolean;
  onForget: (peer: PairedDevice) => void;
  onSync: (peer: PairedDevice) => void;
  peer: PairedDevice;
}) {
  const stamp = peer.lastSyncAt
    ? `Synced ${when.format(new Date(peer.lastSyncAt))}`
    : `Paired ${when.format(new Date(peer.pairedAt))}`;
  return (
    <li className="flex items-center gap-3 rounded-xl bg-muted/60 px-3 py-2">
      <Smartphone className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{peer.name}</p>
        <p className="text-muted-foreground text-xs">{stamp}</p>
      </div>
      {canRelay && (
        <Button
          aria-label={`Sync with ${peer.name} through the relay`}
          onClick={() => onSync(peer)}
          size="icon"
          variant="ghost"
        >
          <RefreshCw className="size-4" />
        </Button>
      )}
      <Button
        aria-label={`Forget ${peer.name}`}
        onClick={() => onForget(peer)}
        size="icon"
        variant="ghost"
      >
        <Trash2 className="size-4" />
      </Button>
    </li>
  );
}

function IdleSections({
  device,
  deviceName,
  onDeviceName,
  onForget,
  onRelayUrl,
  onSaveDeviceName,
  onScan,
  onShowCode,
  onSyncRelay,
  peers,
  relayUrl,
}: {
  device: SyncDevice | null;
  deviceName: string;
  onDeviceName: (name: string) => void;
  onForget: (peer: PairedDevice) => void;
  onRelayUrl: (url: string) => void;
  onSaveDeviceName: () => void;
  onScan: () => void;
  onShowCode: () => void;
  onSyncRelay: (peer: PairedDevice) => void;
  peers: PairedDevice[];
  relayUrl: string;
}) {
  return (
    <>
      <section className="flex flex-col gap-2 rounded-2xl border border-border p-3">
        <p className="font-medium text-xs">This device</p>
        <div className="flex gap-2">
          <Input
            aria-label="Device name"
            className="flex-1"
            onChange={onDeviceName}
            value={deviceName}
          />
          <Button
            disabled={!device || deviceName.trim() === device.name}
            onClick={onSaveDeviceName}
            size="sm"
            variant="outline"
          >
            Save
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <p className="font-medium text-xs">Pair or sync now</p>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onShowCode} size="sm">
            <QrCode className="size-4" />
            Show a code
          </Button>
          <Button onClick={onScan} size="sm" variant="outline">
            <Camera className="size-4" />
            Scan a code
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          One device shows a code, the other scans it (or receives it pasted
          from a message), then sends its reply code back the same way. Both
          screens then show the same six digits to confirm.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <p className="font-medium text-xs">Paired devices · {peers.length}</p>
        {peers.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No devices paired yet. Pairing happens automatically the first time
            two devices sync.
          </p>
        )}
        <ul className="flex flex-col gap-1">
          {peers.map((peer) => (
            <PeerRow
              canRelay={Boolean(relayUrl.trim())}
              key={peer.deviceId}
              onForget={onForget}
              onSync={onSyncRelay}
              peer={peer}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2 rounded-2xl border border-border border-dashed p-3">
        <p className="flex items-center gap-2 font-medium text-xs">
          <Link2 className="size-3.5" />
          Optional relay
        </p>
        <Input
          aria-label="Relay URL"
          onChange={onRelayUrl}
          placeholder="wss://relay.example.com"
          spellCheck={false}
          type="url"
          value={relayUrl}
        />
        <p className="text-muted-foreground text-xs">
          With a relay, paired devices can sync without scanning a code each
          time. The relay only carries encrypted connection setup; your books
          never pass through it. See <code>tools/sync-relay</code> to run your
          own.
        </p>
      </section>
    </>
  );
}

function CodeCard({
  canvasRef,
  mode,
  onCopy,
  onShare,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  mode: Mode;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-center text-sm">
        {mode === "offer"
          ? "Scan this on the other device, or share the code."
          : "Send this reply code back to the first device."}
      </p>
      <canvas
        aria-label="Pairing QR code"
        className="max-w-full rounded-xl bg-white p-2"
        ref={canvasRef}
      />
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={onCopy} size="sm" variant="outline">
          <Copy className="size-4" />
          Copy code
        </Button>
        <Button onClick={onShare} size="sm" variant="outline">
          <Share2 className="size-4" />
          Share
        </Button>
      </div>
      {mode === "answer" && (
        <p className="text-center text-muted-foreground text-xs">
          Waiting for the first device to read the reply…
        </p>
      )}
    </div>
  );
}

function SessionPanel({
  canvasRef,
  onConfirmSas,
  onCopy,
  onEnd,
  onShare,
  view,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  onConfirmSas: () => void;
  onCopy: () => void;
  onEnd: () => void;
  onShare: () => void;
  view: SessionView;
}) {
  const showingCode =
    view.code && (view.phase === "show-code" || view.phase === "await-reply");
  const finished = view.phase === "complete" || view.phase === "error";

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border p-3">
      {view.phase === "starting" && (
        <div className="flex items-center gap-3">
          <Loader label="Preparing the connection" variant="dots" />
          <p className="text-muted-foreground text-sm">
            Preparing the connection…
          </p>
        </div>
      )}

      {showingCode && (
        <CodeCard
          canvasRef={canvasRef}
          mode={view.mode}
          onCopy={onCopy}
          onShare={onShare}
        />
      )}

      {view.phase === "verify" && view.sas && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-center text-sm">
            Confirm both devices show the same digits
          </p>
          <p className="font-mono text-3xl tracking-[0.3em]">{view.sas}</p>
          <div className="flex gap-2">
            <Button onClick={onEnd} size="sm" variant="ghost">
              They differ
            </Button>
            <StatefulButton onClick={onConfirmSas} size="sm" state="idle">
              They match
            </StatefulButton>
          </div>
        </div>
      )}

      {view.phase === "connected" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">
            Connected to{" "}
            <strong>{view.peer?.name ?? "the other device"}</strong>
          </p>
          {view.transfer ? (
            <>
              <p className="text-muted-foreground text-xs">
                {view.transfer.label}
              </p>
              <progress
                className="h-2 w-full"
                max={Math.max(1, view.transfer.total)}
                value={view.transfer.done}
              />
            </>
          ) : (
            <Loader label="Comparing libraries" variant="dots" />
          )}
        </div>
      )}

      {view.phase === "complete" && view.summary && (
        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm">Sync complete</p>
          <p className="text-muted-foreground text-xs">
            {summarize(view.summary)}
          </p>
        </div>
      )}

      {view.phase === "error" && (
        <p className="text-destructive text-sm" role="alert">
          {view.error}
        </p>
      )}

      {view.log.length > 0 && (
        <ul className="text-[11px] text-muted-foreground">
          {view.log.map((line) => (
            <li key={line.id}>{line.message}</li>
          ))}
        </ul>
      )}

      <Button onClick={onEnd} size="sm" variant="outline">
        {finished ? "Done" : "Cancel"}
      </Button>
    </section>
  );
}

export function SyncDrawer({
  open,
  onClose,
  onSynced,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  /** A sync run finished and may have changed the library. */
  onSynced: () => void;
  onError: (message: string) => void;
}) {
  const [device, setDevice] = useState<SyncDevice | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [peers, setPeers] = useState<PairedDevice[]>([]);
  const [relayUrl, setRelayUrl] = useState("");
  const [view, setView] = useState<SessionView>(IDLE);
  const [remoteCode, setRemoteCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const session = useRef<SyncSession | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scanner = useRef<ReturnType<typeof createQrScanner> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const sync = await engine();
      const [me, paired, store] = await Promise.all([
        sync.device,
        sync.listPeers(),
        openLeafletStore(),
      ]);
      setDevice(me);
      setDeviceName(me.name);
      setPeers(paired);
      setRelayUrl((await store.getSetting("syncRelayUrl")) ?? "");
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError]);

  useEffect(() => {
    if (open) {
      refresh();
    }
  }, [open, refresh]);

  const stopScanner = useCallback(() => {
    scanner.current?.stop();
    scanner.current = null;
    setScanning(false);
  }, []);

  const endSession = useCallback(() => {
    session.current?.cancel();
    session.current = null;
    stopScanner();
    setRemoteCode("");
    setView(IDLE);
  }, [stopScanner]);

  useEffect(() => {
    if (!open) {
      endSession();
    }
  }, [open, endSession]);

  useEffect(() => () => endSession(), [endSession]);

  useEffect(() => {
    if (view.code && canvas.current) {
      drawQrCode(canvas.current, view.code).catch((error: unknown) =>
        onError(errorMessage(error))
      );
    }
  }, [view.code, onError]);

  function attach(next: SyncSession, mode: Mode) {
    session.current?.cancel();
    session.current = next;
    setView({ ...IDLE, mode, log: [] });
    next.subscribe((event: SyncEvent) => {
      if (event.type === "complete") {
        onSynced();
        refresh();
      }
      setView((current) => reduceView(current, event));
    });
  }

  const guard = (task: () => Promise<void>) =>
    task().catch((error: unknown) => onError(errorMessage(error)));

  const startOffer = () =>
    guard(async () =>
      attach((await engine()).startManual({ role: "offer" }), "offer")
    );

  const startAnswer = (code: string) =>
    guard(async () =>
      attach(
        (await engine()).startManual({ role: "answer", remoteCode: code }),
        "answer"
      )
    );

  const startRelay = (peer: PairedDevice) =>
    guard(async () =>
      attach(
        (await engine()).startRelay({ peerDeviceId: peer.deviceId, relayUrl }),
        "relay"
      )
    );

  async function submitRemote(code: string) {
    const trimmed = code.trim();
    if (!trimmed) {
      return;
    }
    if (view.mode === "offer" && session.current) {
      const current = session.current;
      await guard(async () => {
        await current.acceptRemoteCode(trimmed);
        setRemoteCode("");
      });
      return;
    }
    await startAnswer(trimmed);
  }

  async function scan() {
    if (!video.current) {
      return;
    }
    stopScanner();
    setScanning(true);
    scanner.current = createQrScanner(video.current, (text) => {
      stopScanner();
      setRemoteCode(text);
      submitRemote(text);
    });
    try {
      await scanner.current.start();
    } catch (error) {
      stopScanner();
      onError(errorMessage(error));
    }
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      setRemoteCode(text);
      await submitRemote(text);
    } catch {
      onError(
        "Clipboard access was denied. Paste the code into the field instead."
      );
    }
  }

  const share = () =>
    guard(async () => {
      if (view.code && !(await shareCode(view.code))) {
        onError("Sharing is unavailable here. Copy the code instead.");
      }
    });

  const copy = () =>
    guard(async () => {
      if (view.code) {
        await navigator.clipboard.writeText(view.code);
      }
    });

  const saveDeviceName = () =>
    guard(async () => {
      await (await engine()).renameDevice(deviceName.trim() || "This device");
      await refresh();
    });

  const saveRelay = (url: string) => {
    setRelayUrl(url);
    return guard(async () => {
      const store = await openLeafletStore();
      if (url.trim()) {
        await store.putSetting("syncRelayUrl", url.trim());
      } else {
        await store.deleteSetting("syncRelayUrl");
      }
    });
  };

  const forget = (peer: PairedDevice) =>
    guard(async () => {
      await (await engine()).forgetPeer(peer.deviceId);
      await refresh();
    });

  const inSession = view.mode !== "idle";
  const awaitingReply = view.mode === "offer" && view.phase === "show-code";
  const showCodeEntry =
    (awaitingReply || !inSession || scanning) &&
    !view.error &&
    view.phase !== "complete";

  return (
    <Drawer
      ariaLabel="Transfer library"
      className="w-full max-w-md"
      onOpenChange={(next) => !next && onClose()}
      open={open}
      side="right"
    >
      <div className="flex items-start justify-between gap-3 border-border border-b p-4">
        <div>
          <p className="eyebrow">Devices</p>
          <h2 className="mt-1 font-semibold text-lg">Transfer library</h2>
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

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <p className="text-muted-foreground text-sm">
          Books, reading positions and trusted sites travel directly between
          your browsers over an encrypted peer connection. Nothing is uploaded
          to a server.
        </p>

        {!inSession && (
          <IdleSections
            device={device}
            deviceName={deviceName}
            onDeviceName={setDeviceName}
            onForget={forget}
            onRelayUrl={saveRelay}
            onSaveDeviceName={saveDeviceName}
            onScan={scan}
            onShowCode={startOffer}
            onSyncRelay={startRelay}
            peers={peers}
            relayUrl={relayUrl}
          />
        )}

        <div className={scanning ? "flex flex-col gap-2" : "hidden"}>
          <video
            aria-label="Camera preview"
            autoPlay
            className="aspect-square w-full rounded-2xl bg-black object-cover"
            muted
            playsInline
            ref={video}
          />
          <Button onClick={stopScanner} size="sm" variant="outline">
            Stop scanning
          </Button>
        </div>

        {showCodeEntry && (
          <section className="flex flex-col gap-2">
            <p className="font-medium text-xs">
              {awaitingReply
                ? "Enter the reply code from the other device"
                : "Or paste a code you received"}
            </p>
            <textarea
              aria-label="Pairing code"
              className="min-h-20 w-full rounded-xl border border-border bg-background p-2 font-mono text-xs"
              onChange={(event) => setRemoteCode(event.target.value)}
              spellCheck={false}
              value={remoteCode}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!remoteCode.trim()}
                onClick={() => submitRemote(remoteCode)}
                size="sm"
              >
                <Check className="size-4" />
                Use code
              </Button>
              <Button onClick={paste} size="sm" variant="outline">
                <ClipboardPaste className="size-4" />
                Paste
              </Button>
              {awaitingReply && (
                <Button onClick={scan} size="sm" variant="outline">
                  <Camera className="size-4" />
                  Scan
                </Button>
              )}
            </div>
          </section>
        )}

        {inSession && (
          <SessionPanel
            canvasRef={canvas}
            onConfirmSas={() => session.current?.confirmSas()}
            onCopy={copy}
            onEnd={endSession}
            onShare={share}
            view={view}
          />
        )}
      </div>
    </Drawer>
  );
}
