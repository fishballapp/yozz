/** RFC 3501 §5.1.3 modified UTF-7: UTF-16BE in base64 with `,` for `/` and no padding, between `&` and `-`. */
const b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,';

const encodeModifiedBase64 = (codeUnits: number[]): string => {
  const bytes: number[] = [];
  for (const cu of codeUnits) {
    bytes.push((cu >> 8) & 0xff);
    bytes.push(cu & 0xff);
  }

  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : null;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : null;

    const idx0 = b0 >> 2;
    result += b64Chars[idx0] ?? '';

    if (b1 !== null) {
      const idx1 = ((b0 & 0x03) << 4) | (b1 >> 4);
      result += b64Chars[idx1] ?? '';
      if (b2 !== null) {
        const idx2 = ((b1 & 0x0f) << 2) | (b2 >> 6);
        const idx3 = b2 & 0x3f;
        result += (b64Chars[idx2] ?? '') + (b64Chars[idx3] ?? '');
        i += 3;
      } else {
        const idx2 = (b1 & 0x0f) << 2;
        result += b64Chars[idx2] ?? '';
        i += 2;
      }
    } else {
      const idx1 = (b0 & 0x03) << 4;
      result += b64Chars[idx1] ?? '';
      i += 1;
    }
  }

  return result;
};

const decodeModifiedBase64 = (str: string): string => {
  const standardB64 = str.replace(/,/g, '/');
  const remainder = standardB64.length % 4;
  const padded = remainder === 0 ? standardB64 : standardB64 + '='.repeat(4 - remainder);

  try {
    const binary = atob(padded);
    let decoded = '';
    for (let i = 0; i + 1 < binary.length; i += 2) {
      const high = binary.charCodeAt(i);
      const low = binary.charCodeAt(i + 1);
      decoded += String.fromCharCode((high << 8) | low);
    }
    return decoded;
  } catch {
    return `&${str}-`;
  }
};

export const encodeModifiedUtf7 = (str: string): string => {
  let result = '';
  let nonAsciiBuffer: number[] = [];

  const flushNonAscii = (): void => {
    if (nonAsciiBuffer.length === 0) return;
    result += `&${encodeModifiedBase64(nonAsciiBuffer)}-`;
    nonAsciiBuffer = [];
  };

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x26) {
      flushNonAscii();
      result += '&-';
    } else if (code >= 0x20 && code <= 0x7e) {
      flushNonAscii();
      result += str[i] ?? '';
    } else {
      nonAsciiBuffer.push(code);
    }
  }

  flushNonAscii();
  return result;
};

export const decodeModifiedUtf7 = (str: string): string => {
  let result = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] === '&') {
      if (i + 1 < str.length && str[i + 1] === '-') {
        result += '&';
        i += 2;
        continue;
      }
      const dashIndex = str.indexOf('-', i + 1);
      if (dashIndex === -1) {
        result += str.slice(i);
        break;
      }
      const b64Part = str.slice(i + 1, dashIndex);
      result += decodeModifiedBase64(b64Part);
      i = dashIndex + 1;
    } else {
      result += str[i] ?? '';
      i++;
    }
  }

  return result;
};
