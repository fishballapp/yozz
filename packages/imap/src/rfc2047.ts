/**
 * RFC 2047 MIME Part Three: Message Header Extensions for Non-ASCII Text.
 *
 * Decodes encoded-words in header fields (Q and B encodings).
 * Crucial invariants:
 * 1. Adjacent encoded-words separated only by linear-white-space (LWS) are joined by their
 *    raw decoded bytes before charset decoding.
 * 2. The output is NEVER re-scanned.
 * 3. Unknown charsets leave the raw word intact.
 */

import { concatByteArrays } from './bytes.ts';

type EncodedWordMatch = {
  readonly start: number;
  readonly end: number;
  readonly raw: string;
  readonly charset: string;
  readonly encoding: 'B' | 'Q';
  readonly encodedText: string;
};

const ENCODED_WORD_REGEX = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

const decodeQToBytes = (text: string): Uint8Array => {
  const bytes: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '_') {
      bytes.push(0x20);
      i++;
    } else if (
      ch === '=' &&
      i + 2 < text.length &&
      /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))
    ) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push((text.charCodeAt(i) ?? 0) & 0xff);
      i++;
    }
  }
  return new Uint8Array(bytes);
};

const decodeBToBytes = (text: string): Uint8Array | null => {
  try {
    const binary = atob(text.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
};

const decodeBytesWithCharset = (bytes: Uint8Array, charset: string): string | null => {
  try {
    const decoder = new TextDecoder(charset);
    return decoder.decode(bytes);
  } catch {
    // Unsupported charset in TextDecoder
    return null;
  }
};

export const decodeRfc2047 = (header: string): string => {
  const matches: EncodedWordMatch[] = [];
  let match: RegExpExecArray | null = null;
  ENCODED_WORD_REGEX.lastIndex = 0;

  while (true) {
    match = ENCODED_WORD_REGEX.exec(header);
    if (match === null) break;

    const raw = match[0];
    const charset = match[1] ?? '';
    const encodingLetter = (match[2] ?? '').toUpperCase();
    const encodedText = match[3] ?? '';
    const start = match.index;
    const end = start + raw.length;

    if (encodingLetter === 'B' || encodingLetter === 'Q') {
      matches.push({
        start,
        end,
        raw,
        charset,
        encoding: encodingLetter,
        encodedText,
      });
    }
  }

  if (matches.length === 0) return header;

  let result = '';
  let cursor = 0;
  let i = 0;

  while (i < matches.length) {
    const current = matches[i];
    if (current === undefined) break;

    // Emit any plain text between cursor and current match
    if (current.start > cursor) {
      result += header.slice(cursor, current.start);
    }

    // Collect all adjacent encoded words
    const adjacentWords: EncodedWordMatch[] = [current];
    let nextIndex = i + 1;

    while (nextIndex < matches.length) {
      const prev = adjacentWords[adjacentWords.length - 1];
      const next = matches[nextIndex];
      if (prev === undefined || next === undefined) break;

      const between = header.slice(prev.end, next.start);
      // Adjacent words are separated ONLY by linear white space (spaces, tabs, CRLF)
      if (/^[ \t\r\n]+$/.test(between)) {
        adjacentWords.push(next);
        nextIndex++;
      } else {
        break;
      }
    }

    // Process the group of adjacent encoded-words
    // Sub-group them by charset for byte-level concatenation
    let j = 0;
    while (j < adjacentWords.length) {
      const firstInCharset = adjacentWords[j];
      if (firstInCharset === undefined) break;

      const sameCharsetWords: EncodedWordMatch[] = [firstInCharset];
      let k = j + 1;
      while (k < adjacentWords.length) {
        const candidate = adjacentWords[k];
        if (
          candidate !== undefined &&
          candidate.charset.toLowerCase() === firstInCharset.charset.toLowerCase()
        ) {
          sameCharsetWords.push(candidate);
          k++;
        } else {
          break;
        }
      }

      // Check if charset is supported
      let isCharsetSupported = true;
      try {
        new TextDecoder(firstInCharset.charset);
      } catch {
        isCharsetSupported = false;
      }

      if (!isCharsetSupported) {
        // Unknown charset leaves the raw words intact
        for (const w of sameCharsetWords) {
          result += w.raw;
        }
      } else {
        const byteChunks: Uint8Array[] = [];
        let hasDecodeError = false;

        for (const w of sameCharsetWords) {
          const chunk =
            w.encoding === 'B' ? decodeBToBytes(w.encodedText) : decodeQToBytes(w.encodedText);
          if (chunk === null) {
            hasDecodeError = true;
            break;
          }
          byteChunks.push(chunk);
        }

        if (hasDecodeError) {
          // If decoding bytes failed (e.g. invalid base64), emit raw
          for (const w of sameCharsetWords) {
            result += w.raw;
          }
        } else {
          const mergedBytes = concatByteArrays(byteChunks);
          const decodedText = decodeBytesWithCharset(mergedBytes, firstInCharset.charset);
          if (decodedText !== null) {
            result += decodedText;
          } else {
            for (const w of sameCharsetWords) {
              result += w.raw;
            }
          }
        }
      }

      j = k;
    }

    const lastWord = adjacentWords[adjacentWords.length - 1];
    cursor = lastWord !== undefined ? lastWord.end : current.end;
    i = nextIndex;
  }

  if (cursor < header.length) {
    result += header.slice(cursor);
  }

  return result;
};
