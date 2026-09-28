import { describe, expect, it } from "vitest";
import {
  type Action,
  CLOSE_FULL,
  CLOSE_IDLE,
  CLOSE_KICKED,
  CLOSE_NOT_FOUND,
  CLOSE_POLICY,
  CLOSE_REPLACED,
  RoomHub,
} from "./hub";

const ROOM = "a".repeat(32);
let secretCounter = 0;
const SECRET = /^secret-/u;
const random = () => {
  secretCounter += 1;
  return `secret-${secretCounter}`;
};

function join(create: boolean, hostSecret?: string): string {
  return JSON.stringify({ type: "join", room: ROOM, create, hostSecret });
}

function data(channel: string, payload = "cGF5bG9hZA", to?: string): string {
  return JSON.stringify({ type: "data", channel, payload, to });
}

function frames(actions: Action[]) {
  return actions.flatMap((action) =>
    "to" in action ? [{ to: action.to, ...action.frame }] : []
  );
}

function closes(actions: Action[]) {
  return actions.flatMap((action) => ("close" in action ? [action] : []));
}

describe("RoomHub", () => {
  it("creates on the first join, refuses joins to unknown rooms, and lists members", () => {
    const hub = new RoomHub(ROOM, {}, { random });
    const refused = hub.handle("guest", join(false), 1);
    expect(frames(refused)).toEqual([
      { to: "guest", type: "error", code: "not_found" },
    ]);
    expect(closes(refused)[0]?.code).toBe(CLOSE_NOT_FOUND);

    const created = hub.handle("host", join(true), 2);
    const joined = frames(created).find((frame) => frame.type === "joined");
    expect(joined).toMatchObject({
      to: "host",
      host: true,
      locked: false,
      members: [],
    });
    expect(joined && "hostSecret" in joined && joined.hostSecret).toMatch(
      SECRET
    );
    expect(created.some((action) => "persist" in action)).toBe(true);
    expect(hub.state.hostSecret).toMatch(SECRET);

    const guest = hub.handle("guest2", join(true), 3);
    const guestJoined = frames(guest).find((frame) => frame.type === "joined");
    expect(guestJoined).toMatchObject({
      host: false,
      members: [{ id: "host", host: true }],
    });
    expect(guestJoined && "hostSecret" in guestJoined).toBe(false);
    expect(frames(guest)).toContainEqual({
      to: "others",
      type: "member-joined",
      member: { id: "guest2", host: false, joinedAt: 3 },
    });
    expect(hub.members.map((member) => member.id)).toEqual(["host", "guest2"]);
  });

  it("caps membership", () => {
    const hub = new RoomHub(ROOM, {}, { random, maxMembers: 2 });
    hub.handle("host", join(true), 1);
    hub.handle("g1", join(false), 2);
    const full = hub.handle("g2", join(false), 3);
    expect(frames(full)).toEqual([
      { to: "g2", type: "error", code: "room_full" },
    ]);
    expect(closes(full)[0]?.code).toBe(CLOSE_FULL);
    expect(hub.members).toHaveLength(2);
  });

  it("fans data out, honours direct delivery, and drops frames to absent members", () => {
    const hub = new RoomHub(ROOM, {}, { random });
    hub.handle("host", join(true), 1);
    hub.handle("g1", join(false), 2);
    expect(frames(hub.handle("host", data("presence"), 3))).toEqual([
      {
        to: "others",
        type: "data",
        from: "host",
        channel: "presence",
        payload: "cGF5bG9hZA",
      },
    ]);
    expect(frames(hub.handle("g1", data("signal", "x", "host"), 4))).toEqual([
      { to: "host", type: "data", from: "g1", channel: "signal", payload: "x" },
    ]);
    expect(hub.handle("g1", data("signal", "x", "nobody"), 5)).toEqual([]);
    const unknown = hub.handle("g1", data("chat"), 6);
    expect(frames(unknown)).toEqual([
      { to: "g1", type: "error", code: "bad_request" },
    ]);
    const notJoined = hub.handle("stranger", data("presence"), 7);
    expect(frames(notJoined)).toEqual([
      { to: "stranger", type: "error", code: "forbidden" },
    ]);
  });

  it("lets only the host lock, and blocks guest notes and bulk while locked", () => {
    const hub = new RoomHub(ROOM, {}, { random });
    hub.handle("host", join(true), 1);
    hub.handle("g1", join(false), 2);
    expect(
      frames(
        hub.handle("g1", JSON.stringify({ type: "policy", locked: true }), 3)
      )
    ).toEqual([{ to: "g1", type: "error", code: "forbidden" }]);
    const locked = hub.handle(
      "host",
      JSON.stringify({ type: "policy", locked: true }),
      4
    );
    expect(frames(locked)).toEqual([
      { to: "all", type: "policy", locked: true },
    ]);
    expect(
      locked.some((action) => "persist" in action && action.persist.locked)
    ).toBe(true);
    expect(frames(hub.handle("g1", data("notes"), 5))).toEqual([
      { to: "g1", type: "error", code: "locked" },
    ]);
    expect(frames(hub.handle("g1", data("bulk"), 6))).toEqual([
      { to: "g1", type: "error", code: "locked" },
    ]);
    expect(frames(hub.handle("g1", data("presence"), 7))[0]?.type).toBe("data");
    expect(frames(hub.handle("host", data("notes"), 8))[0]?.type).toBe("data");
    const late = hub.handle("g2", join(false), 9);
    expect(frames(late).find((frame) => frame.type === "joined")).toMatchObject(
      {
        locked: true,
      }
    );
  });

  it("kicks members and closes their sockets", () => {
    const hub = new RoomHub(ROOM, {}, { random });
    hub.handle("host", join(true), 1);
    hub.handle("g1", join(false), 2);
    expect(
      frames(hub.handle("g1", JSON.stringify({ type: "kick", id: "host" }), 3))
    ).toEqual([{ to: "g1", type: "error", code: "forbidden" }]);
    const kicked = hub.handle(
      "host",
      JSON.stringify({ type: "kick", id: "g1" }),
      4
    );
    expect(closes(kicked)).toEqual([
      { close: "g1", code: CLOSE_KICKED, reason: "kicked" },
    ]);
    expect(frames(kicked)).toEqual([
      { to: "all", type: "member-left", id: "g1" },
    ]);
    expect(hub.members.map((member) => member.id)).toEqual(["host"]);
    expect(
      hub.handle("host", JSON.stringify({ type: "kick", id: "g1" }), 5)
    ).toEqual([]);
  });

  it("rate-limits frames and bytes and closes after three strikes", () => {
    const hub = new RoomHub(
      ROOM,
      {},
      { random, framesPerSecond: 10, frameBurst: 3, strikes: 3 }
    );
    hub.handle("host", join(true), 1000);
    for (let index = 0; index < 2; index += 1) {
      expect(frames(hub.handle("host", data("presence"), 1000))).toHaveLength(
        1
      );
    }
    const first = hub.handle("host", data("presence"), 1000);
    expect(frames(first)).toEqual([
      { to: "host", type: "error", code: "rate_limited" },
    ]);
    const second = hub.handle("host", data("presence"), 1000);
    expect(closes(second)).toEqual([]);
    const third = hub.handle("host", data("presence"), 1000);
    expect(closes(third)[0]).toMatchObject({
      close: "host",
      code: CLOSE_POLICY,
    });
    expect(hub.members).toEqual([]);

    const bytes = new RoomHub(ROOM, {}, { random, bytesPerSecond: 100 });
    bytes.handle("host", join(true), 1);
    const big = data("presence", "x".repeat(150));
    expect(frames(bytes.handle("host", big, 2))).toEqual([
      { to: "host", type: "error", code: "rate_limited" },
    ]);
    // Refills over time.
    expect(frames(bytes.handle("host", data("presence"), 5000))[0]?.type).toBe(
      "data"
    );
  });

  it("closes sockets that send oversized or unparsable frames", () => {
    const hub = new RoomHub(ROOM, {}, { random, maxFrameChars: 100 });
    hub.handle("host", join(true), 1);
    const big = hub.handle("host", "x".repeat(101), 2);
    expect(closes(big)[0]?.code).toBe(1009);
    expect(hub.members).toEqual([]);
    const fresh = new RoomHub(ROOM, {}, { random });
    fresh.handle("host", join(true), 1);
    expect(frames(fresh.handle("host", "{not json", 2))).toEqual([
      { to: "host", type: "error", code: "bad_request" },
    ]);
  });

  it("lets the creator reclaim the host seat with the secret and retires the stale socket", () => {
    const hub = new RoomHub(ROOM, {}, { random });
    const created = hub.handle("host1", join(true), 1);
    const joined = frames(created).find((frame) => frame.type === "joined");
    const secret = joined && "hostSecret" in joined ? joined.hostSecret : "";
    hub.handle("g1", join(false), 2);
    const wrong = hub.handle("host2", join(false, "nope"), 3);
    expect(
      frames(wrong).find((frame) => frame.type === "joined")
    ).toMatchObject({ host: false });
    hub.leave("host2", 3);
    const reclaimed = hub.handle("host3", join(false, secret), 4);
    expect(
      frames(reclaimed).find((frame) => frame.type === "joined")
    ).toMatchObject({
      host: true,
    });
    expect(closes(reclaimed)).toEqual([
      { close: "host1", code: CLOSE_REPLACED, reason: "replaced" },
    ]);
    expect(
      hub.members.filter((member) => member.host).map((member) => member.id)
    ).toEqual(["host3"]);
  });

  it("pings idle sockets, drops silent ones, and times out sockets that never join", () => {
    const hub = new RoomHub(
      ROOM,
      {},
      {
        random,
        pingAfterMs: 30_000,
        dropAfterMissedPings: 2,
        joinTimeoutMs: 10_000,
      }
    );
    hub.handle("host", join(true), 0);
    hub.attach("lurker", 0);
    expect(hub.tick(5000)).toEqual([]);
    const pinged = hub.tick(30_000);
    expect(frames(pinged)).toEqual([{ to: "host", type: "ping" }]);
    expect(closes(pinged)[0]).toMatchObject({ close: "lurker" });
    hub.handle("host", JSON.stringify({ type: "pong" }), 31_000);
    expect(hub.tick(40_000)).toEqual([]);
    expect(frames(hub.tick(61_000))).toEqual([{ to: "host", type: "ping" }]);
    expect(frames(hub.tick(91_000))).toEqual([{ to: "host", type: "ping" }]);
    const dropped = hub.tick(121_000);
    expect(closes(dropped)[0]).toMatchObject({
      close: "host",
      code: CLOSE_IDLE,
    });
    expect(hub.members).toEqual([]);
  });

  it("schedules deletion when the room empties and wipes it after the expiry", () => {
    const hub = new RoomHub(ROOM, {}, { random, expireAfterMs: 1000 });
    hub.handle("host", join(true), 0);
    const left = hub.leave("host", 10);
    expect(left).toContainEqual({ deleteAt: 1010 });
    expect(hub.state.emptySince).toBe(10);
    // A return cancels the deletion.
    const back = hub.handle("host2", join(false), 20);
    expect(back).toContainEqual({ deleteAt: null });
    expect(hub.state.emptySince).toBeNull();
    hub.leave("host2", 30);
    expect(hub.tick(500)).toEqual([]);
    const expired = hub.tick(1030);
    expect(expired).toContainEqual({ expire: true });
    expect(hub.state).toEqual({
      createdAt: null,
      emptySince: null,
      hostSecret: null,
      locked: false,
    });
    // The room can be created again afterwards.
    expect(
      frames(hub.handle("h", join(true), 2000)).find(
        (frame) => frame.type === "joined"
      )
    ).toMatchObject({
      host: true,
    });
  });

  it("restores members after the transport wakes up", () => {
    const hub = new RoomHub(
      ROOM,
      { hostSecret: "s", locked: true, createdAt: 1, emptySince: null },
      { random }
    );
    hub.restore("host", { id: "host", host: true, joinedAt: 1 }, 50);
    hub.restore("g1", { id: "g1", host: false, joinedAt: 2 }, 50);
    expect(hub.members.map((member) => member.id)).toEqual(["host", "g1"]);
    expect(frames(hub.handle("g1", data("notes"), 60))).toEqual([
      { to: "g1", type: "error", code: "locked" },
    ]);
    expect(frames(hub.handle("host", data("notes"), 61))[0]?.type).toBe("data");
  });
});
