/**
 * An in-memory relay for tests: the real `RoomHub` logic behind fake
 * WebSockets, so the client, the reading session and the transfer engine can
 * be exercised end to end without a network.
 */
import { type Action, RoomHub } from "../../../../workers/rooms/src/hub";
import type { SocketLike } from "../client";

const OPEN = 1;
const CLOSED = 3;
const ENDPOINT = /\/v1\/rooms\/([0-9a-f]{32})$/u;

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  bufferedAmount = 0;
  readonly id: string;
  readonly sent: string[] = [];
  private readonly relay: FakeRelay;
  private readonly roomId: string;

  constructor(relay: FakeRelay, roomId: string, id: string) {
    this.relay = relay;
    this.roomId = roomId;
    this.id = id;
  }

  /** Called by the relay once the "connection" is established. */
  open(): void {
    if (this.readyState !== 0) {
      return;
    }
    this.readyState = OPEN;
    this.onopen?.();
  }

  send(data: string): void {
    if (this.readyState !== OPEN) {
      throw new Error("Socket is not open.");
    }
    this.sent.push(data);
    this.relay.deliverToHub(this.roomId, this.id, data);
  }

  /** The relay pushes a frame to this client. */
  receive(data: string): void {
    if (this.readyState === OPEN) {
      this.relay.schedule(() => this.onmessage?.({ data }));
    }
  }

  close(code = 1000, reason = ""): void {
    this.relay.closeSocket(this.roomId, this.id, code, reason, true);
  }

  /** Server-side close (kick, idle, refusal). */
  serverClose(code: number, reason: string): void {
    if (this.readyState === CLOSED) {
      return;
    }
    this.readyState = CLOSED;
    this.relay.schedule(() => this.onclose?.({ code, reason }));
  }

  /** Simulate the network dropping without a clean close. */
  drop(): void {
    this.relay.closeSocket(this.roomId, this.id, 1006, "dropped", false);
  }

  markClosed(): void {
    this.readyState = CLOSED;
  }
}

export class FakeRelay {
  readonly hubs = new Map<string, RoomHub>();
  readonly sockets = new Map<string, FakeSocket>();
  private counter = 0;
  private clock = 0;
  /** When true, new sockets never open (simulates an unreachable relay). */
  unreachable = false;
  private readonly hubOptions: ConstructorParameters<typeof RoomHub>[2];

  constructor(hubOptions: ConstructorParameters<typeof RoomHub>[2] = {}) {
    this.hubOptions = hubOptions;
  }

  now(): number {
    this.clock += 1;
    return this.clock;
  }

  schedule(task: () => void): void {
    queueMicrotask(task);
  }

  /** `createSocket` for the room client. */
  createSocket = (url: string): SocketLike => {
    const match = ENDPOINT.exec(url);
    if (!match) {
      throw new Error(`Unexpected relay endpoint ${url}`);
    }
    const roomId = match[1];
    this.counter += 1;
    const socket = new FakeSocket(this, roomId, `m${this.counter}`);
    this.sockets.set(socket.id, socket);
    if (this.unreachable) {
      this.schedule(() => socket.serverClose(1006, "unreachable"));
    } else {
      this.schedule(() => {
        this.hub(roomId).attach(socket.id, this.now());
        socket.open();
      });
    }
    return socket;
  };

  hub(roomId: string): RoomHub {
    let hub = this.hubs.get(roomId);
    if (!hub) {
      hub = new RoomHub(roomId, {}, this.hubOptions);
      this.hubs.set(roomId, hub);
    }
    return hub;
  }

  membersOf(roomId: string): string[] {
    return this.hub(roomId).members.map((member) => member.id);
  }

  deliverToHub(roomId: string, socketId: string, raw: string): void {
    const hub = this.hub(roomId);
    this.apply(roomId, hub.handle(socketId, raw, this.now()), socketId);
  }

  closeSocket(
    roomId: string,
    socketId: string,
    code: number,
    reason: string,
    clean: boolean
  ): void {
    const socket = this.sockets.get(socketId);
    if (!socket || socket.readyState === CLOSED) {
      return;
    }
    socket.markClosed();
    const hub = this.hub(roomId);
    this.apply(roomId, hub.leave(socketId, this.now()), socketId);
    if (!clean) {
      this.schedule(() => socket.onclose?.({ code, reason }));
    }
  }

  tick(roomId: string, now: number): void {
    const hub = this.hubs.get(roomId);
    if (hub) {
      this.apply(roomId, hub.tick(now), null);
    }
  }

  private apply(roomId: string, actions: Action[], origin: string | null) {
    const hub = this.hub(roomId);
    for (const action of actions) {
      if ("to" in action) {
        const text = JSON.stringify(action.frame);
        const targets =
          action.to === "all" || action.to === "others"
            ? hub.members
                .map((member) => member.id)
                .filter(
                  (id) =>
                    action.to === "all" || id !== (action.from ?? origin ?? "")
                )
            : [action.to];
        for (const id of targets) {
          this.sockets.get(id)?.receive(text);
        }
      } else if ("close" in action) {
        const socket = this.sockets.get(action.close);
        socket?.serverClose(action.code, action.reason);
      }
      // persist / deleteAt / expire are storage concerns with no in-memory effect.
    }
  }
}
