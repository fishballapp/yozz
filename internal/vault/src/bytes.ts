/**
 * The byte and text operations the key schedule and the record crypto both
 * need, and nothing else.
 *
 * Base64 is the platform's own `Uint8Array.toBase64` / `Uint8Array.fromBase64`
 * rather than a `btoa(String.fromCharCode(...bytes))` line. That idiom spreads
 * the array into an argument list, which is fine for a 32-byte digest and
 * throws `RangeError` on a mailbox-sized record — the failure arrives at
 * whatever size the caller's data happens to reach, which is the worst kind of
 * limit to discover. The builtins landed in Chromium, Gecko and WebKit in early
 * 2025, ahead of the WebCrypto X25519 support `@yozz.app/tls` already requires, so
 * they cost no reach.
 */

export type VaultFailureCode =
  /** A string that should have been base64 was not, or decoded to the wrong length. */
  | 'malformed'
  /**
   * AES-GCM refused to authenticate. WHICH call failed is the diagnosis, and
   * the caller is the only one who knows: `openVault` failing means the
   * password or the device secret is wrong, and a read failing AFTER the vault
   * opened means the store did not answer with the record that was asked for.
   */
  | 'unreadable'
  /**
   * The record authenticated and is genuine — it is simply not the newest one
   * this device has already seen under that id, which is a store replaying a
   * superseded revision.
   *
   * **This is a third code where "wrong password" deliberately is not one**, and
   * the difference is what can be KNOWN rather than guessed. AES-GCM cannot tell
   * a wrong password from a tampered ciphertext, so a code claiming to would be
   * inventing a diagnosis. A revision behind a recorded high-water mark is a
   * fact, and it sends a reader somewhere completely different from
   * `unreadable`: not "your key is wrong" but "your store answered with
   * yesterday's row".
   */
  | 'stale';

export class VaultError extends Error {
  readonly code: VaultFailureCode;

  constructor(code: VaultFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'VaultError';
    this.code = code;
  }
}

/**
 * The copy every WebCrypto input in this repo goes through — `@yozz.app/x509`'s
 * verifier and `@yozz.app/tls`'s record layer, key schedule, key share and verifier
 * all have this line. WebCrypto's types want a buffer proven not to be shared,
 * which a view into someone else's array cannot prove, and a `subarray` also
 * carries a `byteOffset` into a longer buffer. The spec says an implementation
 * must copy the view's bytes; four implementations of one spec is exactly the
 * place this project stopped assuming that a year ago.
 */
export const nonShared = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes);

export const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

export const toBase64 = (bytes: Uint8Array): string => bytes.toBase64();

/**
 * Unpadded, because the two things carried in this alphabet — a record id and a
 * device secret — both travel in URLs, and `=` in a query string is one more
 * way to arrive re-encoded. `fromBase64` accepts either form on the way back.
 */
export const toBase64Url = (bytes: Uint8Array): string =>
  bytes.toBase64({ alphabet: 'base64url', omitPadding: true });

/**
 * Every base64 string this package reads came off a server it does not trust,
 * so a decode failure is an ordinary outcome rather than a bug. `fromBase64`
 * throws `SyntaxError`, which a caller catching `VaultError` would miss.
 */
export const fromBase64 = (
  text: string,
  what: string,
  alphabet: 'base64' | 'base64url' = 'base64',
): Uint8Array<ArrayBuffer> => {
  try {
    return Uint8Array.fromBase64(text, { alphabet });
  } catch {
    throw new VaultError('malformed', `${what} is not ${alphabet}`);
  }
};
