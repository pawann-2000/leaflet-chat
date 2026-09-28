import { describe, expect, it, vi } from "vitest";
import { createRoom, joinRoom, type RoomEvent, relayEndpoint } from "./client";
import { decodeJson } from "./envelope";
import { RoomError } from "./errors";
import { FakeRelay, type FakeSocket } from "./testing/fake-relay";

const RELAY = "wss://rooms.test";
const CODE = "ABCD-EFGH-JKMN";

function record(): {
  events: RoomEvent[];
  listener: (event: RoomEvent) => void;
} {
  const events: RoomEvent[] = [];
  return { events, listener: (event) => events.push(event) };
}

async function until(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(() => {
    expect(check(), label).toBe(true);
  });
}

describe("relayEndpoint", () => {
  it("builds the versioned room path and validates the relay address", () => {
    const id = "0".repeat(32);
    expect(relayEndpoint("wss://rooms.leaflet.chat", id)).toBe(
      `wss://rooms.leaflet.chat/v1/rooms/${id}`
    );
    expect(relayEndpoint("ws://127.0.0.1:8787/base/", id)).toBe(
      `ws://127.0.0.1:8787/base/v1/rooms/${id}`
    );
    expect(() => relayEndpoint("https://rooms.leaflet.chat", id)).toThrowError(
      RoomError
    );
    expect(() => relayEndpoint("wss://user:pw@rooms.test", id)).toThrowError(
      RoomError
    );
    expect(() => relayEndpoint("wss://rooms.test", "nope")).toThrowError(
      RoomError
    );
  });
});

describe("room client", () => {
  it("creates a room, lets a guest join, and delivers sealed messages both ways", async () => {
    const relay = new FakeRelay();
    const transport = { createSocket: relay.createSocket, storage: null };
    const host = await createRoom({ relayUrl: RELAY, code: CODE, transport });
    expect(host.code).toBe(CODE);
    expect(host.client.isHost).toBe(true);
    expect(host.client.state).toBe("open");
    expect(host.client.members).toEqual([]);

    const hostLog = record();
    host.client.subscribe(hostLog.listener);
    const guest = await joinRoom({
      relayUrl: RELAY,
      code: "abcdefghjkmn",
      transport,
    });
    expect(guest.isHost).toBe(false);
    expect(guest.members.map((member) => member.id)).toEqual([host.client.id]);
    await until(
      () => hostLog.events.some((event) => event.type === "member-joined"),
      "host sees the guest"
    );

    const guestLog = record();
    guest.subscribe(guestLog.listener);
    host.client.send("presence", { hello: "from host" });
    guest.send("notes", new Uint8Array([9, 8, 7]), host.client.id);
    await until(
      () => guestLog.events.some((event) => event.type === "message"),
      "guest receives"
    );
    await until(
      () => hostLog.events.some((event) => event.type === "message"),
      "host receives"
    );
    const toGuest = guestLog.events.find((event) => event.type === "message");
    const toHost = hostLog.events.find((event) => event.type === "message");
    expect(toGuest?.type === "message" && toGuest.kind).toBe("json");
    expect(toGuest?.type === "message" && decodeJson(toGuest.data)).toEqual({
      hello: "from host",
    });
    expect(toHost?.type === "message" && toHost.channel).toBe("notes");
    expect(toHost?.type === "message" && toHost.data).toEqual(
      new Uint8Array([9, 8, 7])
    );

    // The relay only ever saw sealed payloads.
    for (const socket of relay.sockets.values()) {
      for (const raw of socket.sent) {
        expect(raw).not.toContain("from host");
      }
    }

    host.client.setLocked(true);
    await until(
      () =>
        guestLog.events.some(
          (event) => event.type === "policy" && event.locked
        ),
      "policy reaches the guest"
    );
    expect(guest.locked).toBe(true);
    expect(() => guest.setLocked(false)).toThrowError(RoomError);

    host.client.kick(guest.id);
    await until(
      () => guestLog.events.some((event) => event.type === "closed"),
      "guest is kicked"
    );
    const closed = guestLog.events.find((event) => event.type === "closed");
    expect(closed?.type === "closed" && closed.code).toBe("kicked");
    expect(guest.state).toBe("closed");
    await until(
      () => hostLog.events.some((event) => event.type === "member-left"),
      "host sees the guest leave"
    );
    host.client.close();
    expect(host.client.state).toBe("closed");
  });

  it("rejects joining a room nobody created and a full room", async () => {
    const relay = new FakeRelay({ maxMembers: 2 });
    const transport = { createSocket: relay.createSocket, storage: null };
    await expect(
      joinRoom({ relayUrl: RELAY, code: CODE, transport })
    ).rejects.toMatchObject({ code: "not_found" });
    const host = await createRoom({ relayUrl: RELAY, code: CODE, transport });
    const guest = await joinRoom({ relayUrl: RELAY, code: CODE, transport });
    await expect(
      joinRoom({ relayUrl: RELAY, code: CODE, transport })
    ).rejects.toMatchObject({ code: "room_full" });
    guest.close();
    host.client.close();
  });

  it("reports an unreachable relay and a bad code before opening anything", async () => {
    const relay = new FakeRelay();
    relay.unreachable = true;
    await expect(
      createRoom({
        relayUrl: RELAY,
        code: CODE,
        transport: { createSocket: relay.createSocket, storage: null },
      })
    ).rejects.toMatchObject({ code: "network" });
    await expect(
      joinRoom({ relayUrl: RELAY, code: "not a code", transport: {} })
    ).rejects.toMatchObject({ code: "bad_code" });
  });

  it("reconnects after a dropped socket, reclaims the host seat and re-emits open", async () => {
    const relay = new FakeRelay();
    const timers: (() => void)[] = [];
    const transport = {
      createSocket: relay.createSocket,
      storage: null,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    };
    const host = await createRoom({ relayUrl: RELAY, code: CODE, transport });
    const guest = await joinRoom({ relayUrl: RELAY, code: CODE, transport });
    const guestLog = record();
    guest.subscribe(guestLog.listener);
    const hostLog = record();
    host.client.subscribe(hostLog.listener);
    const firstId = host.client.id;

    const hostSocket = [...relay.sockets.values()].find(
      (socket) => socket.id === firstId
    ) as FakeSocket;
    hostSocket.drop();
    await until(
      () => hostLog.events.some((event) => event.type === "reconnecting"),
      "host schedules a reconnect"
    );
    expect(host.client.state).toBe("connecting");
    await until(
      () => guestLog.events.some((event) => event.type === "member-left"),
      "guest sees the host drop"
    );
    // Fire the backoff timer: the client dials again with its host secret.
    const backoff = timers.pop();
    backoff?.();
    await until(() => host.client.state === "open", "host is back");
    expect(host.client.isHost).toBe(true);
    expect(host.client.id).not.toBe(firstId);
    expect(hostLog.events.filter((event) => event.type === "open").length).toBe(
      1
    );
    await until(
      () =>
        guestLog.events.some(
          (event) => event.type === "member-joined" && event.member.isHost
        ),
      "guest sees the host return as host"
    );
    // Messages flow again after the reconnect.
    host.client.send("presence", { back: true });
    await until(
      () => guestLog.events.some((event) => event.type === "message"),
      "guest receives after reconnect"
    );
    host.client.close();
    guest.close();
  });

  it("drops replayed frames and closes after too many unreadable ones", async () => {
    const relay = new FakeRelay();
    const transport = { createSocket: relay.createSocket, storage: null };
    const host = await createRoom({ relayUrl: RELAY, code: CODE, transport });
    const guest = await joinRoom({ relayUrl: RELAY, code: CODE, transport });
    const guestLog = record();
    guest.subscribe(guestLog.listener);
    host.client.send("presence", { n: 1 });
    await until(
      () =>
        guestLog.events.filter((event) => event.type === "message").length ===
        1,
      "first message"
    );
    const guestSocket = relay.sockets.get(guest.id) as FakeSocket;
    const hostSocket = relay.sockets.get(host.client.id) as FakeSocket;
    const dataFrame = hostSocket.sent.find((raw) => raw.includes('"data"'));
    if (!dataFrame) {
      throw new Error("no data frame was sent");
    }
    // Replay the exact frame as if the relay re-delivered it.
    const relayed = JSON.stringify({
      ...(JSON.parse(dataFrame) as Record<string, unknown>),
      from: host.client.id,
    });
    guestSocket.receive(relayed);
    for (let index = 0; index < 25; index += 1) {
      guestSocket.receive(
        JSON.stringify({
          type: "data",
          from: host.client.id,
          channel: "presence",
          payload: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        })
      );
    }
    await until(
      () => guestLog.events.some((event) => event.type === "closed"),
      "guest gives up on garbage"
    );
    expect(
      guestLog.events.filter((event) => event.type === "message").length
    ).toBe(1);
    host.client.close();
  });

  it("refuses oversized messages synchronously", async () => {
    const relay = new FakeRelay();
    const host = await createRoom({
      relayUrl: RELAY,
      code: CODE,
      transport: { createSocket: relay.createSocket, storage: null },
    });
    expect(() =>
      host.client.send("bulk", new Uint8Array(60 * 1024))
    ).toThrowError(RoomError);
    host.client.close();
    expect(() => host.client.send("bulk", { late: true })).toThrowError(
      RoomError
    );
  });
});
