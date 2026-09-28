import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRelay } from "@/lib/rooms/testing/fake-relay";
import { createReadingSession, peekRoom, type ReadingSession } from "./session";
import type { ContentLocator } from "./types";

const RELAY = "wss://rooms.test";
const chapters = ["c1", "c2"];
const fingerprint = (name: string): string =>
  createHash("sha256").update(name).digest("hex");
const passage: ContentLocator = {
  chapterId: "c1",
  start: 4,
  end: 12,
  quote: "a passage",
};
const place: ContentLocator = {
  chapterId: "c2",
  start: 30,
  end: 30,
  quote: "",
};
const noChange = (): void => undefined;
const CODE_SHAPE = /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u;

let counter = 0;
const open = new Set<ReadingSession>();

async function session(
  book: string,
  relay: FakeRelay,
  onError: (error: Error) => void = noChange
): Promise<ReadingSession> {
  counter += 1;
  const created = await createReadingSession(
    book,
    chapters,
    noChange,
    onError,
    {
      storageName: `room-test-${counter}`,
      transport: { createSocket: relay.createSocket, storage: null },
    }
  );
  open.add(created);
  return created;
}

afterEach(async () => {
  await Promise.all([...open].map((item) => item.destroy()));
  open.clear();
});

describe("reading rooms", () => {
  it("converges notes and positions between a host and a guest", async () => {
    const relay = new FakeRelay();
    const book = fingerprint("shared-book");
    const hostErrors: Error[] = [];
    const guestErrors: Error[] = [];
    const host = await session(book, relay, (error) => hostErrors.push(error));
    const guest = await session(book, relay, (error) =>
      guestErrors.push(error)
    );
    host.add("comment", passage, "Host note");
    guest.add("highlight", passage);

    const view = await host.host({
      relayUrl: RELAY,
      name: "Ada",
      bookTitle: "The Book",
      guestsCanAnnotate: true,
    });
    expect(view.code).toMatch(CODE_SHAPE);
    expect(view.url).toBe(`https://leaflet.chat/join#${view.code}`);
    expect(view.role).toBe("host");
    expect(view.members.map((member) => member.name)).toEqual(["Ada"]);
    expect(host.status).toContain("waiting for readers");

    const joined = await guest.join(view.code.toLowerCase(), {
      relayUrl: RELAY,
      name: "Bo",
    });
    expect(joined.role).toBe("guest");
    expect(joined.bookTitle).toBe("The Book");
    expect(joined.members.find((member) => member.isHost)?.name).toBe("Ada");

    await vi.waitFor(() => {
      expect(guest.annotations.map((note) => note.text)).toContain("Host note");
      expect(host.annotations.map((note) => note.kind)).toContain("highlight");
    });
    await vi.waitFor(() => {
      expect(host.room?.members.map((member) => member.name)).toEqual([
        "Ada",
        "Bo",
      ]);
    });
    expect(host.status).toContain("1 reader with you");

    guest.add("comment", { ...passage, chapterId: "c2" }, "Live from Bo");
    await vi.waitFor(() => {
      expect(host.annotations.map((note) => note.text)).toContain(
        "Live from Bo"
      );
    });
    expect(
      host.annotations.find((note) => note.text === "Live from Bo")?.author
    ).toMatchObject({ name: "Bo" });

    guest.saveLocation(place);
    await vi.waitFor(() => {
      const bo = host.room?.members.find((member) => member.name === "Bo");
      expect(bo?.location).toEqual(place);
    });
    expect(host.remoteLocation).toEqual(place);

    host.remove(
      host.annotations.find((note) => note.text === "Host note")?.id ?? ""
    );
    await vi.waitFor(() => {
      expect(guest.annotations.map((note) => note.text)).not.toContain(
        "Host note"
      );
    });

    guest.leave();
    expect(guest.room).toBeNull();
    await vi.waitFor(() => {
      expect(host.room?.members).toHaveLength(1);
    });
    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
  });

  it("locks guests out of writing while still sharing the host's notes", async () => {
    const relay = new FakeRelay();
    const book = fingerprint("locked-book");
    const host = await session(book, relay);
    const guest = await session(book, relay);
    guest.add("comment", passage, "Private guest note");
    const view = await host.host({
      relayUrl: RELAY,
      name: "Ada",
      bookTitle: "Locked",
      guestsCanAnnotate: false,
    });
    expect(view.locked).toBe(true);
    host.add("comment", passage, "From the host");
    await guest.join(view.code, { relayUrl: RELAY, name: "Bo" });
    expect(guest.canAnnotate).toBe(false);
    expect(guest.role).toBe("read");
    expect(() => guest.add("highlight", passage)).toThrow("locked");
    await vi.waitFor(() => {
      expect(guest.annotations.map((note) => note.text)).toContain(
        "From the host"
      );
    });
    // A read-only guest never uploads its private notes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.annotations.map((note) => note.text)).not.toContain(
      "Private guest note"
    );
    expect(guest.status).toContain("read-only");

    host.setGuestsCanAnnotate(true);
    await vi.waitFor(() => {
      expect(guest.canAnnotate).toBe(true);
      // Annotation access shares the notes made while locked or offline.
      expect(host.annotations.map((note) => note.text)).toContain(
        "Private guest note"
      );
    });
    guest.add("bookmark", place);
    await vi.waitFor(() => {
      expect(host.annotations.some((note) => note.kind === "bookmark")).toBe(
        true
      );
    });
    expect(() => guest.setGuestsCanAnnotate(false)).toThrow("host");
  });

  it("refuses to join a room that is reading a different book", async () => {
    const relay = new FakeRelay();
    const host = await session(fingerprint("book-one"), relay);
    const stranger = await session(fingerprint("book-two"), relay);
    const view = await host.host({
      relayUrl: RELAY,
      name: "Ada",
      bookTitle: "Book One",
      guestsCanAnnotate: true,
    });
    await expect(
      stranger.join(view.code, { relayUrl: RELAY, name: "Cy" })
    ).rejects.toThrow("same EPUB");
    expect(stranger.room).toBeNull();
    await vi.waitFor(() => {
      expect(host.room?.members).toHaveLength(1);
    });
  });

  it("rejects unknown codes, empty rooms and malformed codes", async () => {
    const relay = new FakeRelay();
    const guest = await session(fingerprint("lonely"), relay);
    await expect(
      guest.join("ABCD-EFGH-JKMN", { relayUrl: RELAY, name: "Bo" })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      guest.join("nope", { relayUrl: RELAY, name: "Bo" })
    ).rejects.toMatchObject({ code: "bad_code" });
    await expect(
      peekRoom("ABCD-EFGH-JKMN", RELAY, {
        transport: { createSocket: relay.createSocket, storage: null },
      })
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("peeks at a room to learn which book to open, and lets the host kick", async () => {
    const relay = new FakeRelay();
    const book = fingerprint("peekable");
    const host = await session(book, relay);
    const view = await host.host({
      relayUrl: RELAY,
      name: "Ada",
      bookTitle: "Peekable",
      guestsCanAnnotate: true,
    });
    const peek = await peekRoom(view.code, RELAY, {
      transport: { createSocket: relay.createSocket, storage: null },
    });
    expect(peek).toEqual({
      bookTitle: "Peekable",
      fingerprint: book,
      hostName: "Ada",
      members: 1,
    });
    await vi.waitFor(() => {
      expect(host.room?.members).toHaveLength(1);
    });

    const guestErrors: Error[] = [];
    const guest = await session(book, relay, (error) =>
      guestErrors.push(error)
    );
    await guest.join(view.code, { relayUrl: RELAY, name: "Bo" });
    await vi.waitFor(() => {
      expect(host.room?.members.map((member) => member.name)).toContain("Bo");
    });
    const bo = host.room?.members.find((member) => member.name === "Bo");
    host.kick(bo?.id ?? "");
    await vi.waitFor(() => {
      expect(guest.room).toBeNull();
      expect(guestErrors[0]?.message).toContain("removed");
    });
    expect(() => guest.kick("x")).toThrow("host");
  });

  it("uses the same relay session for the deprecated pairing surface", async () => {
    const relay = new FakeRelay();
    const solo = await session(fingerprint("deprecated"), relay);
    await expect(solo.createOffer("read")).rejects.toThrow("room codes");
    await expect(solo.acceptOffer("x")).rejects.toThrow("room codes");
    await expect(solo.acceptAnswer("x")).rejects.toThrow("room codes");
    expect(solo.fingerprints).toBe("");
    expect(solo.pairingCode).toBe("");
    solo.disconnect();
    expect(solo.room).toBeNull();
  });
});
