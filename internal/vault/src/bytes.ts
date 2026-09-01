export type VaultFailureCode =
  | 'malformed'
  /** AES-GCM refused to authenticate: a wrong password from `openVault`, a substituted row from a read. */
  | 'unreadable'
  /** Genuine, but behind the revision this device has already seen: the store replayed a superseded row. */
  | 'stale';

export class VaultError extends Error {
  readonly code: VaultFailureCode;

  constructor(code: VaultFailureCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** WebCrypto's types want a buffer proven not to be shared, and a `subarray` view cannot prove it. */
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

/** Unpadded, because a record id travels in URLs. */
export const toBase64Url = (bytes: Uint8Array): string =>
  bytes.toBase64({ alphabet: 'base64url', omitPadding: true });

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
