import {
  Check,
  Copy,
  Crown,
  DoorOpen,
  Link2,
  LogOut,
  MapPin,
  Share2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, StatefulButton } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { Input } from "@/components/motion/input";
import { Switch } from "@/components/motion/switch";
import {
  saveReaderName,
  saveRelayUrl,
  storedReaderName,
  storedRelayUrl,
} from "@/features/reading/room-settings";
import { errorMessage } from "@/lib/errors";
import type { ContentLocator } from "@/lib/reader/locator";
import type { MemberView, ReadingSession } from "@/lib/reading-sync";
import { DEFAULT_RELAY_URL, normalizeRoomCode, roomJoinUrl } from "@/lib/rooms";
import { drawQrCode, shareCode } from "@/lib/sync/qr";

const URL_SCHEME = /^https?:\/\//u;

function memberPlace(member: MemberView): string {
  if (!member.location) {
    return "Finding their place…";
  }
  return member.location.quote
    ? `“${member.location.quote.slice(0, 48)}…”`
    : "Reading now";
}

function MemberRow({
  member,
  isHost,
  following,
  onFollow,
  onKick,
  onVisit,
}: {
  member: MemberView;
  isHost: boolean;
  following: boolean;
  onFollow: () => void;
  onKick?: () => void;
  onVisit?: (locator: ContentLocator) => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-muted/60">
      <span
        aria-hidden="true"
        className="grid size-8 shrink-0 place-items-center rounded-full font-semibold text-[11px] text-white"
        style={{ background: member.color }}
      >
        {member.name.slice(0, 1).toLocaleUpperCase() || "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 truncate font-medium text-sm">
          {member.isMe ? "You" : member.name}
          {member.isHost && (
            <Crown
              aria-label="Host"
              className="size-3.5 text-gold-foreground"
            />
          )}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {memberPlace(member)}
        </span>
      </span>
      {!member.isMe && member.location && onVisit && (
        <Button
          aria-label={`Go to ${member.name}'s page`}
          onClick={() => {
            const target = member.location;
            if (target) {
              onVisit(target);
            }
          }}
          size="icon"
          variant="ghost"
        >
          <MapPin className="size-4" />
        </Button>
      )}
      {!member.isMe && (
        <Button
          aria-pressed={following}
          className={following ? "text-coral" : undefined}
          onClick={onFollow}
          size="sm"
          variant="ghost"
        >
          {following ? "Following" : "Follow"}
        </Button>
      )}
      {isHost && !member.isMe && onKick && (
        <Button
          aria-label={`Remove ${member.name}`}
          onClick={onKick}
          size="icon"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      )}
    </li>
  );
}

export function TogetherDrawer({
  open,
  session,
  revision,
  bookTitle,
  initialCode,
  followingId,
  onFollow,
  onVisit,
  onClose,
  onError,
}: {
  open: boolean;
  session: ReadingSession | null;
  revision: number;
  bookTitle: string;
  /** A code arriving from a `/join#code` link; pre-fills and auto-joins. */
  initialCode: string | null;
  followingId: string | null;
  onFollow: (memberId: string | null) => void;
  onVisit: (locator: ContentLocator) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(storedReaderName);
  const [relayUrl, setRelayUrl] = useState(storedRelayUrl);
  const [code, setCode] = useState(initialCode ?? "");
  const [guestsCanAnnotate, setGuestsCanAnnotate] = useState(true);
  const [busy, setBusy] = useState<"host" | "join" | null>(null);
  const [copied, setCopied] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const autoJoined = useRef<string | null>(null);
  const room = session?.room ?? null;

  useEffect(() => {
    if (initialCode) {
      setCode(initialCode);
    }
  }, [initialCode]);

  useEffect(() => {
    if (room?.url && canvas.current) {
      drawQrCode(canvas.current, room.url).catch(() => undefined);
    }
  }, [room?.url]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  async function run(kind: "host" | "join", task: () => Promise<unknown>) {
    if (busy || !session) {
      return;
    }
    saveReaderName(name.trim() || "Reader");
    saveRelayUrl(relayUrl);
    setBusy(kind);
    try {
      await task();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const host = () =>
    run("host", () =>
      (session as ReadingSession).host({
        relayUrl: relayUrl.trim() || DEFAULT_RELAY_URL,
        name: name.trim() || "Reader",
        bookTitle,
        guestsCanAnnotate,
      })
    );

  const join = (value: string) => {
    const normalized = normalizeRoomCode(value);
    if (!normalized) {
      onError(
        "That doesn't look like a room code. Codes look like ABCD-EFGH-JKLM."
      );
      return Promise.resolve();
    }
    return run("join", () =>
      (session as ReadingSession).join(normalized, {
        relayUrl: relayUrl.trim() || DEFAULT_RELAY_URL,
        name: name.trim() || "Reader",
      })
    );
  };

  // A join link opens the drawer with the code; join as soon as the session
  // exists. `join` closes over fresh state, so the effect reads it via a ref.
  const joinRef = useRef(join);
  joinRef.current = join;
  useEffect(() => {
    if (
      open &&
      session &&
      initialCode &&
      !room &&
      autoJoined.current !== initialCode &&
      name.trim()
    ) {
      autoJoined.current = initialCode;
      joinRef.current(initialCode);
    }
  }, [open, session, initialCode, room, name]);

  async function copyLink() {
    if (!room) {
      return;
    }
    try {
      await navigator.clipboard.writeText(room.url);
      setCopied(true);
    } catch {
      onError("Copying was blocked. Select the code and copy it by hand.");
    }
  }

  async function share() {
    if (!room) {
      return;
    }
    try {
      const shared = await shareCode(
        `Read “${bookTitle}” with me on Leaflet: ${roomJoinUrl(room.code)}`
      );
      if (!shared) {
        await copyLink();
      }
    } catch (error) {
      onError(errorMessage(error));
    }
  }

  const members = room?.members ?? [];
  const isHost = room?.role === "host";

  return (
    <Drawer
      ariaLabel="Read together"
      className="w-full max-w-md"
      onOpenChange={(next) => !next && onClose()}
      open={open}
      side="right"
    >
      <div className="flex items-start justify-between gap-3 border-border border-b p-4">
        <div>
          <p className="eyebrow">Read together</p>
          <h2 className="mt-1 font-serif text-2xl">
            {room ? "Your reading room" : "Invite readers"}
          </h2>
          <p className="mt-1 text-muted-foreground text-xs" role="status">
            {room
              ? room.status
              : "Everyone opens the same EPUB; only notes and places travel, end-to-end encrypted."}
          </p>
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

      <div className="scrollbar-paper flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {!session && (
          <p className="text-muted-foreground text-sm">
            Open a book to start or join a reading room.
          </p>
        )}

        {session && !room && (
          <>
            <Input
              autoComplete="nickname"
              label="Your name in the room"
              maxLength={40}
              onChange={setName}
              placeholder="Mira"
              value={name}
            />

            <section className="paper flex flex-col gap-3 rounded-2xl p-4">
              <div className="flex items-center gap-2">
                <DoorOpen className="size-4 text-coral" />
                <h3 className="font-semibold text-sm">Start a room</h3>
              </div>
              <p className="text-muted-foreground text-xs">
                You get a short code and a link. Readers who open “{bookTitle}”
                and enter the code see each other's places and notes.
              </p>
              <Switch
                checked={guestsCanAnnotate}
                label="Guests can highlight and add notes"
                onCheckedChange={setGuestsCanAnnotate}
              />
              <StatefulButton
                disabled={busy !== null || !name.trim()}
                loadingText="Opening the room…"
                onClick={host}
                size="sm"
                state={busy === "host" ? "loading" : "idle"}
              >
                Create a room code
              </StatefulButton>
            </section>

            <section className="paper flex flex-col gap-3 rounded-2xl p-4">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-leaf" />
                <h3 className="font-semibold text-sm">Join a room</h3>
              </div>
              <Input
                aria-label="Room code"
                autoCapitalize="characters"
                autoComplete="off"
                className="font-mono tracking-[0.18em]"
                onChange={(value) => setCode(value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    join(code);
                  }
                }}
                placeholder="ABCD-EFGH-JKLM"
                spellCheck={false}
                value={code}
              />
              <StatefulButton
                disabled={busy !== null || !code.trim() || !name.trim()}
                loadingText="Joining…"
                onClick={() => join(code)}
                size="sm"
                state={busy === "join" ? "loading" : "idle"}
                variant="outline"
              >
                Join with code
              </StatefulButton>
            </section>

            <button
              className="text-left text-muted-foreground text-xs underline-offset-2 hover:underline"
              onClick={() => setAdvanced((value) => !value)}
              type="button"
            >
              {advanced ? "Hide" : "Use your own relay"}
            </button>
            {advanced && (
              <Input
                label="Relay"
                onChange={setRelayUrl}
                placeholder={DEFAULT_RELAY_URL}
                spellCheck={false}
                type="url"
                value={relayUrl}
              />
            )}
          </>
        )}

        {session && room && (
          <>
            <section className="paper flex flex-col items-center gap-3 rounded-2xl p-4 text-center">
              <p className="eyebrow">Room code</p>
              <p className="font-mono text-2xl tracking-[0.2em]">{room.code}</p>
              <canvas
                aria-label="Room QR code"
                className="w-40 max-w-full rounded-xl bg-white p-2"
                ref={canvas}
              />
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={copyLink} size="sm" variant="outline">
                  {copied ? (
                    <Check className="size-4 text-leaf" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button onClick={share} size="sm" variant="outline">
                  <Share2 className="size-4" />
                  Share
                </Button>
              </div>
              <p className="flex items-center gap-1 text-muted-foreground text-xs">
                <Link2 className="size-3" />
                {room.url.replace(URL_SCHEME, "")}
              </p>
            </section>

            {isHost && (
              <Switch
                checked={!room.locked}
                label="Guests can highlight and add notes"
                onCheckedChange={(allowed) => {
                  try {
                    session.setGuestsCanAnnotate(allowed);
                  } catch (error) {
                    onError(errorMessage(error));
                  }
                }}
              />
            )}

            <section className="flex flex-col gap-1">
              <p className="eyebrow px-2">Readers · {members.length}</p>
              <ul className="flex flex-col">
                {members.map((member) => (
                  <MemberRow
                    following={followingId === member.id}
                    isHost={isHost}
                    key={member.id}
                    member={member}
                    onFollow={() =>
                      onFollow(followingId === member.id ? null : member.id)
                    }
                    onKick={
                      isHost
                        ? () => {
                            try {
                              session.kick(member.id);
                            } catch (error) {
                              onError(errorMessage(error));
                            }
                          }
                        : undefined
                    }
                    onVisit={onVisit}
                  />
                ))}
              </ul>
              {members.length <= 1 && (
                <p className="px-2 text-muted-foreground text-xs">
                  Waiting for readers. Share the code or link above.
                </p>
              )}
            </section>

            <Button
              onClick={() => {
                session.leave();
                onFollow(null);
              }}
              size="sm"
              variant="outline"
            >
              <LogOut className="size-4" />
              Leave the room
            </Button>
          </>
        )}
        <span className="hidden" data-revision={revision} />
      </div>
    </Drawer>
  );
}
