/**
 * Local relay for development: the same `RoomHub` logic as the Durable
 * Object, served with `ws` on `ws://127.0.0.1:8787/v1/rooms/<roomId>`.
 *
 *   node dev-server.ts                       (Node ≥ 24: type stripping is on)
 *   node --experimental-strip-types dev-server.ts   (Node 22)
 *
 * Point the app at it with relay address `ws://127.0.0.1:8787`.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { type Action, RoomHub } from "./src/hub.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ROOM_PATH = /^\/v1\/rooms\/([0-9a-f]{32})$/u;
const TICK_MS = 30_000;

interface Room {
  hub: RoomHub;
  sockets: Map<string, WebSocket>;
}

const rooms = new Map<string, Room>();

function room(roomId: string): Room {
  let entry = rooms.get(roomId);
  if (!entry) {
    entry = { hub: new RoomHub(roomId), sockets: new Map() };
    rooms.set(roomId, entry);
  }
  return entry;
}

function apply(entry: Room, actions: Action[]): void {
  for (const action of actions) {
    if ("to" in action) {
      const text = JSON.stringify(action.frame);
      if (action.to === "all" || action.to === "others") {
        for (const member of entry.hub.members) {
          if (action.to === "all" || member.id !== action.from) {
            entry.sockets.get(member.id)?.send(text);
          }
        }
      } else {
        entry.sockets.get(action.to)?.send(text);
      }
    } else if ("close" in action) {
      entry.sockets.get(action.close)?.close(action.code, action.reason);
      entry.sockets.delete(action.close);
    } else if ("expire" in action) {
      // In-memory state only: nothing else to wipe.
    }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on("upgrade", (request: IncomingMessage, socket, head) => {
  const match = ROOM_PATH.exec(request.url ?? "");
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];
  wss.handleUpgrade(request, socket, head, (ws) => {
    const entry = room(roomId);
    const id = randomUUID().replaceAll("-", "").slice(0, 24);
    entry.sockets.set(id, ws);
    apply(entry, entry.hub.attach(id, Date.now()));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(1008, "text only");
        return;
      }
      apply(entry, entry.hub.handle(id, data.toString(), Date.now()));
    });
    ws.on("close", () => {
      entry.sockets.delete(id);
      apply(entry, entry.hub.leave(id, Date.now()));
    });
    ws.on("error", () => ws.close());
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [roomId, entry] of rooms) {
    apply(entry, entry.hub.tick(now));
    if (!entry.sockets.size && entry.hub.state.hostSecret === null) {
      rooms.delete(roomId);
    }
  }
}, TICK_MS).unref();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`leaflet rooms dev relay: ws://127.0.0.1:${PORT}`);
});
