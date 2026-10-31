/**
 * A raw message split the way DKIM reads it, and canonicalised exactly per RFC 6376 §3.4. The
 * header block is small and must survive byte for byte, so it is held as a byte string (one char
 * per byte, never decoded); the body can be megabytes, so it stays bytes and is walked once.
 * A bare LF ends a line as CRLF does, since a store that rewrote line ends did not change the mail.
 */

export type Canonicalization = 'simple' | 'relaxed';

/** One header field as it arrived, folds included and line ends made CRLF, without its final CRLF. */
export type HeaderField = {
  /** Lowercased, without the whitespace an obsolete header puts before its colon. */
  readonly name: string;
  /** A byte string. */
  readonly raw: string;
};

export type SplitMessage = {
  /** In document order. */
  readonly headers: readonly HeaderField[];
  readonly body: Uint8Array;
};

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;

export const byteString = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  // Spread in chunks: one call per header block would overflow the argument limit on a big one.
  for (let start = 0; start < bytes.length; start += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  }
  return chunks.join('');
};

export const bytesOf = (byteString: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(byteString, char => char.charCodeAt(0));

/** An RFC 5322 field name, then the optional WSP of obsolete syntax (§3.4.5's example has it), then the colon. */
const FIELD_NAME = /^([\x21-\x39\x3b-\x7e]+)[ \t]*:/;

/**
 * The header fields and the body, or null when the header block is not clean: a CR outside CRLF,
 * or a line that is neither a field nor a fold. Another parser (postal-mime, the IMAP server) may
 * read such a block as other headers, or end it elsewhere, so what it shows would not be what
 * was verified. A CR CR LF line ends postal-mime's headers, for one.
 */
export const splitMessage = (raw: Uint8Array): SplitMessage | null => {
  const bodyStart = (() => {
    let lineStart = 0;
    while (lineStart < raw.length) {
      const lf = raw.indexOf(LF, lineStart);
      if (lf === -1) return raw.length;
      const isEmptyLine = lf === lineStart || (lf === lineStart + 1 && raw[lineStart] === CR);
      if (isEmptyLine) return lf + 1;
      lineStart = lf + 1;
    }
    return raw.length;
  })();
  const block = byteString(raw.subarray(0, bodyStart));
  if (/\r(?!\n)/.test(block)) return null;
  // The empty line and the final line end split off as empty strings; nothing else can be empty.
  const fields = block
    .replace(/\r?\n/g, '\r\n')
    .split(/\r\n(?![ \t])/)
    .filter(field => field !== '');
  const headers: HeaderField[] = [];
  for (const field of fields) {
    const name = FIELD_NAME.exec(field)?.[1];
    if (name === undefined) return null;
    headers.push({ name: name.toLowerCase(), raw: field });
  }
  return { headers, body: raw.subarray(bodyStart) };
};

/** One field, CRLF-terminated. Every CRLF inside a field is a fold. */
export const canonicalHeader = (field: HeaderField, canonicalization: Canonicalization): string => {
  if (canonicalization === 'simple') return `${field.raw}\r\n`;
  const value = field.raw
    .slice(field.raw.indexOf(':') + 1)
    .replaceAll('\r\n', '')
    .replace(/[ \t]+/g, ' ')
    // Not `trim()`: it would also eat 0x85 and 0xA0, which are bytes of the value here.
    .replace(/^ | $/g, '');
  return `${field.name}:${value}\r\n`;
};

/** The canonical body, each line CRLF-terminated, trailing empty lines removed. */
export const canonicalBody = (
  body: Uint8Array,
  canonicalization: Canonicalization,
): Uint8Array<ArrayBuffer> => {
  const lineCount = (() => {
    let count = 0;
    for (let lf = body.indexOf(LF); lf !== -1; lf = body.indexOf(LF, lf + 1)) count++;
    return count;
  })();
  // Room for a CR before every bare LF and a CRLF after an unterminated last line.
  const out = new Uint8Array(body.length + lineCount + 2);
  // `length` ends after the last non-empty line; empty lines are written only once one follows them.
  let length = 0;
  let pendingEmptyLines = 0;
  let lineStart = 0;
  while (lineStart < body.length) {
    const lf = body.indexOf(LF, lineStart);
    const lineEnd = (() => {
      if (lf === -1) return body.length;
      return lf > lineStart && body[lf - 1] === CR ? lf - 1 : lf;
    })();
    const contentStart = length + pendingEmptyLines * 2;
    const contentEnd =
      canonicalization === 'simple'
        ? copyLine(body, lineStart, lineEnd, out, contentStart)
        : relaxLine(body, lineStart, lineEnd, out, contentStart);
    lineStart = lf === -1 ? body.length : lf + 1;
    if (contentEnd === contentStart) {
      pendingEmptyLines++;
      continue;
    }
    for (let at = length; at < contentStart; at += 2) out.set([CR, LF], at);
    out.set([CR, LF], contentEnd);
    length = contentEnd + 2;
    pendingEmptyLines = 0;
  }
  // Simple keeps one CRLF for an empty body; relaxed leaves it empty (RFC 6376 §3.4.3, §3.4.4).
  if (canonicalization === 'simple' && length === 0) return new Uint8Array([CR, LF]);
  return out.subarray(0, length);
};

/** Writes `body[start, end)` at `at`, returning where it stopped. */
const copyLine = (body: Uint8Array, start: number, end: number, out: Uint8Array, at: number) => {
  out.set(body.subarray(start, end), at);
  return at + end - start;
};

/** Writes the line with each run of WSP made one SP, the run at its end dropped, returning where it stopped. */
const relaxLine = (body: Uint8Array, start: number, end: number, out: Uint8Array, at: number) => {
  let cursor = at;
  let isAfterWhitespace = false;
  for (let index = start; index < end; index++) {
    const byte = body[index];
    if (byte === undefined) break;
    if (byte === SP || byte === HTAB) {
      isAfterWhitespace = true;
      continue;
    }
    // A run at the START of a line survives as one SP; only the run at its end goes.
    if (isAfterWhitespace) out[cursor++] = SP;
    isAfterWhitespace = false;
    out[cursor++] = byte;
  }
  return cursor;
};
