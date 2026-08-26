/**
 * Byte-level primitives and ASCII utilities for IMAP stream handling.
 * Zero external dependencies.
 */

export const CR = 0x0d;
export const LF = 0x0a;
export const SPACE = 0x20;
export const TAB = 0x09;
export const DQUOTE = 0x22;
export const BACKSLASH = 0x5c;
export const LPAREN = 0x28;
export const RPAREN = 0x29;
export const LBRACKET = 0x5b;
export const RBRACKET = 0x5d;
export const LBRACE = 0x7b;
export const RBRACE = 0x7d;
export const PLUS = 0x2b;

export const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
};

export const concatByteArrays = (arrays: readonly Uint8Array[]): Uint8Array => {
  let totalLength = 0;
  for (const arr of arrays) {
    totalLength += arr.length;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

const asciiDecoder = new TextDecoder('ascii');
const textEncoder = new TextEncoder();

export const asciiToString = (bytes: Uint8Array): string => asciiDecoder.decode(bytes);

export const stringToBytes = (str: string): Uint8Array => textEncoder.encode(str);

export const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let result = '';
  const len = bytes.length;
  let i = 0;

  while (i < len) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : null;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : null;

    const idx0 = b0 >> 2;
    result += B64_CHARS[idx0] ?? '';

    if (b1 !== null) {
      const idx1 = ((b0 & 0x03) << 4) | (b1 >> 4);
      result += B64_CHARS[idx1] ?? '';
      if (b2 !== null) {
        const idx2 = ((b1 & 0x0f) << 2) | (b2 >> 6);
        const idx3 = b2 & 0x3f;
        result += (B64_CHARS[idx2] ?? '') + (B64_CHARS[idx3] ?? '');
        i += 3;
      } else {
        const idx2 = (b1 & 0x0f) << 2;
        result += (B64_CHARS[idx2] ?? '') + '=';
        i += 2;
      }
    } else {
      const idx1 = (b0 & 0x03) << 4;
      result += (B64_CHARS[idx1] ?? '') + '==';
      i += 1;
    }
  }

  return result;
};
