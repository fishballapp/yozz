/** The one sealed format, for records, wraps and the CLI token: base64 of `iv ‖ AES-GCM(…)`. */

import { concat, fromBase64, nonShared, toBase64, VaultError } from './bytes.ts';

/** RFC 5116 §5.1. */
const IV_BYTES = 12;

export const sealed = (iv: Uint8Array, body: Uint8Array): string => toBase64(concat(iv, body));

export const unseal = (
  text: string,
  what: string,
): { iv: Uint8Array<ArrayBuffer>; body: Uint8Array<ArrayBuffer> } => {
  const bytes = fromBase64(text, what);
  if (bytes.length <= IV_BYTES) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes, too short to hold an IV`);
  }
  return { iv: nonShared(bytes.subarray(0, IV_BYTES)), body: nonShared(bytes.subarray(IV_BYTES)) };
};

/** Random, not a counter: several devices write under one DEK without seeing each other. NIST SP 800-38D bounds this at ~2^32 writes per DEK. */
export const freshIv = (): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(IV_BYTES));
