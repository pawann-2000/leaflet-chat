import { describe, expect, it } from "vitest";
import { ensureDeviceIdentity, guessDeviceName } from "./identity";
import { FakeStore } from "./testing/fake-store";

const UUID = /^[0-9a-f-]{36}$/u;

function nav(
  userAgent: string,
  extra: Record<string, unknown> = {}
): Navigator {
  return { userAgent, ...extra } as unknown as Navigator;
}

describe("guessDeviceName", () => {
  it.each([
    [
      "Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36",
      "Chrome on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1",
      "Safari on iPhone",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
      "Firefox on Linux",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0 Safari/537.36 Edg/124.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Version/17.4 Safari/605.1.15",
      "Safari on Mac",
    ],
  ])("names %s", (agent, expected) => {
    expect(guessDeviceName(nav(agent))).toBe(expected);
  });

  it("prefers userAgentData brands when present", () => {
    const agent =
      "Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36";
    expect(
      guessDeviceName(
        nav(agent, {
          userAgentData: {
            platform: "Android",
            brands: [{ brand: "Not-A.Brand" }, { brand: "Brave" }],
          },
        })
      )
    ).toBe("Brave on Android");
  });
});

describe("ensureDeviceIdentity", () => {
  it("mints once and reuses afterwards", async () => {
    const store = new FakeStore();
    const first = await ensureDeviceIdentity(store);
    const second = await ensureDeviceIdentity(store);
    expect(second).toEqual(first);
    expect(first.privateKey.d).toBeTypeOf("string");
    expect(first.publicKey.d).toBeUndefined();
    expect(first.deviceId).toMatch(UUID);
  });
});
