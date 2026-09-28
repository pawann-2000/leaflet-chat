/**
 * WebSocket relay client.
 *
 * Wire protocol (JSON text frames, ≤ 128 KiB):
 *
 *   client → relay   { "type": "join",   "room": "<64 hex>" }
 *   client → relay   { "type": "signal", "room": "<64 hex>", "payload": "<string>" }
 *   relay  → client  { "type": "joined", "room": "<64 hex>", "peers": <0|1> }
 *   relay  → client  { "type": "peer-joined" }
 *   relay  → client  { "type": "peer-left" }
 *   relay  → client  { "type": "signal", "payload": "<string>" }
 *   relay  → client  { "type": "error",  "reason": "<string>" }
 *
 * A room holds at most two members. `payload` is always an AES-GCM envelope
 * sealed with the pairing key (see `crypto.ts`), so the relay routes opaque
 * strings and cannot read, forge or replay a usable offer.
 */
import { SyncError } from "./errors";

export interface RelayHandlers {
  onClose(reason: string): void;
  onPeerJoined(): void;
  onSignal(payload: string): void;
}

export interface RelayConnection {
  close(): void;
  /** Number of other members present when we joined. */
  readonly peersPresent: number;
  send(payload: string): void;
}

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_FRAME = 128 * 1024;

export function validateRelayUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SyncError(
      "bad_relay_url",
      "The relay address is not a valid URL."
    );
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new SyncError(
      "bad_relay_url",
      "The relay address must start with wss:// or ws://."
    );
  }
  if (url.username || url.password) {
    throw new SyncError(
      "bad_relay_url",
      "The relay address cannot contain credentials."
    );
  }
  return url.toString();
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string" || data.length > MAX_FRAME) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function connectRelay(
  relayUrl: string,
  room: string,
  handlers: RelayHandlers
): Promise<RelayConnection> {
  if (typeof WebSocket === "undefined") {
    throw new SyncError(
      "relay_unsupported",
      "This browser cannot open WebSocket connections."
    );
  }
  const url = validateRelayUrl(relayUrl);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    let closed = false;
    let peersPresent = 0;

    /** Runs `outcome` once, for whichever of joined/error/close/timeout comes first. */
    const settle = (outcome: () => void): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      outcome();
      return true;
    };
    const closeWith = (reason: string) => {
      if (!closed) {
        closed = true;
        handlers.onClose(reason);
      }
    };
    const timer = setTimeout(() => {
      if (
        settle(() =>
          reject(new SyncError("relay_timeout", "The relay did not answer."))
        )
      ) {
        socket.close();
      }
    }, CONNECT_TIMEOUT_MS);

    const connection: RelayConnection = {
      get peersPresent() {
        return peersPresent;
      },
      send: (payload) => {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new SyncError(
            "relay_closed",
            "The relay connection is closed."
          );
        }
        socket.send(JSON.stringify({ type: "signal", room, payload }));
      },
      close: () => {
        closed = true;
        socket.close();
      },
    };

    const onJoined = (message: Record<string, unknown>) => {
      settle(() => {
        peersPresent = typeof message.peers === "number" ? message.peers : 0;
        resolve(connection);
      });
    };
    const onError = (message: Record<string, unknown>) => {
      const reason =
        typeof message.reason === "string"
          ? message.reason
          : "The relay refused the request.";
      if (!settle(() => reject(new SyncError("relay_error", reason)))) {
        closeWith(reason);
      }
      socket.close();
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: "join", room }));
    socket.onerror = () => {
      settle(() =>
        reject(
          new SyncError("relay_unreachable", "The relay could not be reached.")
        )
      );
    };
    socket.onclose = () => {
      if (
        !settle(() =>
          reject(
            new SyncError(
              "relay_unreachable",
              "The relay closed the connection."
            )
          )
        )
      ) {
        closeWith("The relay connection closed.");
      }
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      const message = parseFrame(event.data);
      if (!message) {
        return;
      }
      switch (message.type) {
        case "joined":
          onJoined(message);
          return;
        case "peer-joined":
          handlers.onPeerJoined();
          return;
        case "signal":
          if (typeof message.payload === "string") {
            handlers.onSignal(message.payload);
          }
          return;
        case "error":
          onError(message);
          return;
        default:
          return;
      }
    };
  });
}
