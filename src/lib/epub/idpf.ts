/**
 * IDPF font obfuscation (http://www.idpf.org/2008/embedding).
 *
 * The first 1040 bytes of an obfuscated font are XOR-ed with the SHA-1 digest
 * of the publication's unique identifier, stripped of whitespace. The
 * algorithm is symmetric, so the same function obfuscates and reverses.
 */

export const IDPF_FONT_OBFUSCATION = "http://www.idpf.org/2008/embedding";
const OBFUSCATED_PREFIX_LENGTH = 1040;

export async function idpfFontKey(identifier: string): Promise<Uint8Array> {
  const normalized = identifier.replace(/[ \t\r\n]/gu, "");
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(normalized)
  );
  return new Uint8Array(digest);
}

/** Reverses (or applies) the obfuscation in place and returns the same buffer. */
export function deobfuscateIdpfFont(
  bytes: Uint8Array,
  key: Uint8Array
): Uint8Array {
  const limit = Math.min(OBFUSCATED_PREFIX_LENGTH, bytes.length);
  for (let index = 0; index < limit; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: XOR is the specified algorithm.
    bytes[index] ^= key[index % key.length];
  }
  return bytes;
}
