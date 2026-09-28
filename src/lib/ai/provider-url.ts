import { ProviderError } from "./errors";

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") {
    return true;
  }
  if (IPV4_LOOPBACK.test(host)) {
    return true;
  }
  // The URL parser brackets IPv6 hosts; normalise "::1" and its long forms.
  const bare = host.replace(/^\[|\]$/gu, "");
  return bare === "::1" || bare === "0:0:0:0:0:0:0:1";
}

/**
 * Port of `reader_security::validate_provider_url`.
 *
 * Accepts only HTTP(S) endpoints without credentials, query, or fragment.
 * Loopback hosts are allowed without opt-in; any other host requires
 * `allowRemote`. The returned URL always ends with `/` so `new URL("models",
 * base)` resolves inside the endpoint.
 */
export function validateProviderUrl(input: string, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ProviderError("invalid_url", "invalid provider URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError(
      "invalid_scheme",
      "the provider URL must use HTTP or HTTPS"
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderError(
      "invalid_endpoint",
      "the provider URL cannot contain credentials, a query, or a fragment"
    );
  }
  if (!(allowRemote || isLoopbackHost(url.hostname))) {
    throw new ProviderError(
      "remote_endpoint_denied",
      "remote AI endpoints require explicit opt-in"
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}
