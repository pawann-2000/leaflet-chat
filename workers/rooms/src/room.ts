// biome-ignore-all lint/correctness/noUndeclaredVariables: WebSocketPair and WebSocketRequestResponsePair are Workers runtime globals (typed by @cloudflare/workers-types).
/**
 * One Durable Object per room id. Uses the WebSocket Hibernation API so an
 * idle room costs nothing between messages; membership is rebuilt from the
 * sockets' attachments and the room's persisted state on every wake.
 */
import { DurableObject } from "cloudflare:workers";
import {
  type Action,
  CLOSE_POLICY,
  type MemberInfo,
  type PersistedState,
  RoomHub,
} from "./hub";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
}

interface Attachment {
  id: string;
  member: MemberInfo | null;
}

const STATE_KEY = "state";
const ROOM_ID_KEY = "roomId";
const DELETE_AT_KEY = "deleteAt";
const TICK_MS = 30_000;
const ROOM_ID = /^[0-9a-f]{32}$/u;

function attachmentOf(ws: WebSocket): Attachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Partial<Attachment>;
  return typeof record.id === "string"
    ? { id: record.id, member: record.member ?? null }
    : null;
}

function sendQuietly(ws: WebSocket, text: string): void {
  try {
    ws.send(text);
  } catch {
    // The socket is already gone; its close event will clean up.
  }
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

export class RoomDurableObject extends DurableObject<Env> {
  private hub: RoomHub | null = null;
  private roomId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Client keepalives are answered without waking the object.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
  }

  private async load(roomId: string): Promise<RoomHub> {
    if (this.hub && this.roomId === roomId) {
      return this.hub;
    }
    const stored = await this.ctx.storage.get<PersistedState>(STATE_KEY);
    if ((await this.ctx.storage.get<string>(ROOM_ID_KEY)) !== roomId) {
      await this.ctx.storage.put(ROOM_ID_KEY, roomId);
    }
    const hub = new RoomHub(roomId, stored ?? {});
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws);
      if (!attachment) {
        continue;
      }
      if (attachment.member) {
        hub.restore(attachment.id, attachment.member, now);
      } else {
        hub.attach(attachment.id, now);
      }
    }
    this.hub = hub;
    this.roomId = roomId;
    return hub;
  }

  private socketsFor(id: string): WebSocket[] {
    return this.ctx.getWebSockets(id);
  }

  private deliver(hub: RoomHub, action: Extract<Action, { to: string }>) {
    const text = JSON.stringify(action.frame);
    if (action.to === "all" || action.to === "others") {
      for (const member of hub.members) {
        if (action.to === "all" || member.id !== action.from) {
          for (const ws of this.socketsFor(member.id)) {
            sendQuietly(ws, text);
          }
        }
      }
      return;
    }
    for (const ws of this.socketsFor(action.to)) {
      sendQuietly(ws, text);
    }
  }

  private async schedule(deleteAt: number | null): Promise<void> {
    if (deleteAt === null) {
      await this.ctx.storage.delete(DELETE_AT_KEY);
    } else {
      await this.ctx.storage.put(DELETE_AT_KEY, deleteAt);
    }
  }

  private async expire(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.hub = null;
    this.roomId = null;
  }

  /** Membership changed for some sockets: keep their attachments truthful across hibernation. */
  private refreshAttachments(hub: RoomHub): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = attachmentOf(ws);
      if (!attachment) {
        continue;
      }
      const member = hub.memberOf(attachment.id);
      if (JSON.stringify(member) !== JSON.stringify(attachment.member)) {
        ws.serializeAttachment({ id: attachment.id, member });
      }
    }
  }

  private async apply(hub: RoomHub, actions: Action[]): Promise<void> {
    let reschedule = false;
    for (const action of actions) {
      if ("to" in action) {
        this.deliver(hub, action);
      } else if ("close" in action) {
        for (const ws of this.socketsFor(action.close)) {
          closeQuietly(ws, action.code, action.reason);
        }
      } else if ("persist" in action) {
        await this.ctx.storage.put(STATE_KEY, action.persist);
      } else if ("deleteAt" in action) {
        await this.schedule(action.deleteAt);
        reschedule = true;
      } else if ("expire" in action) {
        await this.expire();
        return;
      }
    }
    this.refreshAttachments(hub);
    if (reschedule) {
      await this.scheduleAlarm(hub);
    }
  }

  /** One alarm covers pings, idle drops and expiry; nothing runs while the room is idle and empty. */
  private async scheduleAlarm(hub: RoomHub): Promise<void> {
    const deleteAt = await this.ctx.storage.get<number>(DELETE_AT_KEY);
    let next: number | null = null;
    if (this.ctx.getWebSockets().length > 0) {
      next = Date.now() + TICK_MS;
    } else if (deleteAt !== undefined) {
      next = deleteAt;
    }
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || !hub.members.length) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const roomId = new URL(request.url).pathname.split("/").at(-1) ?? "";
    if (!ROOM_ID.test(roomId)) {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const hub = await this.load(roomId);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    server.serializeAttachment({ id, member: null } satisfies Attachment);
    this.ctx.acceptWebSocket(server, [id]);
    await this.apply(hub, hub.attach(id, Date.now()));
    await this.scheduleAlarm(hub);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const attachment = attachmentOf(ws);
    if (!(attachment && this.roomId)) {
      closeQuietly(ws, CLOSE_POLICY, "unknown socket");
      return;
    }
    const hub = await this.load(this.roomId);
    if (typeof message !== "string") {
      await this.apply(hub, [
        { close: attachment.id, code: CLOSE_POLICY, reason: "text only" },
        ...hub.leave(attachment.id, Date.now()),
      ]);
      return;
    }
    await this.apply(hub, hub.handle(attachment.id, message, Date.now()));
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.forget(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.forget(ws);
  }

  private async forget(ws: WebSocket): Promise<void> {
    const attachment = attachmentOf(ws);
    if (!(attachment && this.roomId)) {
      return;
    }
    const hub = await this.load(this.roomId);
    await this.apply(hub, hub.leave(attachment.id, Date.now()));
  }

  async alarm(): Promise<void> {
    // After hibernation the id comes back from storage (written on first load).
    const roomId =
      this.roomId ?? (await this.ctx.storage.get<string>(ROOM_ID_KEY));
    if (!roomId) {
      return;
    }
    const hub = await this.load(roomId);
    await this.apply(hub, hub.tick(Date.now()));
    if (this.hub) {
      await this.scheduleAlarm(hub);
    }
  }
}
