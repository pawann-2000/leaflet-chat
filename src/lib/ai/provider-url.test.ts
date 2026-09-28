import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors";
import { validateProviderUrl } from "./provider-url";

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ProviderError ? error.code : undefined;
  }
  return undefined;
};

describe("validateProviderUrl", () => {
  it("accepts loopback provider urls without opt-in", () => {
    expect(validateProviderUrl("http://127.0.0.1:11434/v1", false).href).toBe(
      "http://127.0.0.1:11434/v1/"
    );
    expect(validateProviderUrl("http://localhost:8888/v1/", false).href).toBe(
      "http://localhost:8888/v1/"
    );
    expect(validateProviderUrl("http://[::1]:11434/v1", false).href).toBe(
      "http://[::1]:11434/v1/"
    );
  });

  it("rejects remote or credentialed urls by default", () => {
    expect(
      code(() => validateProviderUrl("http://192.168.1.5:8000/v1", false))
    ).toBe("remote_endpoint_denied");
    expect(
      code(() => validateProviderUrl("http://token@localhost:8000/v1", false))
    ).toBe("invalid_endpoint");
    expect(
      code(() => validateProviderUrl("http://localhost:8000/v1?x=1", false))
    ).toBe("invalid_endpoint");
    expect(
      code(() => validateProviderUrl("http://localhost:8000/v1#frag", false))
    ).toBe("invalid_endpoint");
  });

  it("requires http or https", () => {
    expect(code(() => validateProviderUrl("ftp://localhost/v1", true))).toBe(
      "invalid_scheme"
    );
    expect(code(() => validateProviderUrl("not a url", true))).toBe(
      "invalid_url"
    );
  });

  it("remote urls need an explicit opt-in", () => {
    expect(
      validateProviderUrl("https://models.example.test/v1", true).href
    ).toBe("https://models.example.test/v1/");
  });
});
