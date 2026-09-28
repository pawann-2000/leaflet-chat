// biome-ignore-all lint/performance/noBarrelFile: Wrangler discovers the Durable Object class through this entry module.
/**
 * `rooms.leaflet.chat` — the WebSocket entry point. Every room id maps to
 * one Durable Object; the Worker only routes upgrades and answers health
 * checks. Payloads are end-to-end encrypted by the clients, so nothing here
 * ever inspects or logs them.
 */
import type { Env } from "./room";

export { RoomDurableObject } from "./room";

const ROOM_PATH = /^\/v1\/rooms\/([0-9a-f]{32})$/u;

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", {
        headers: { "cache-control": "no-store" },
      });
    }
    const match = ROOM_PATH.exec(url.pathname);
    if (!match || request.method !== "GET") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const roomId = match[1];
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
