import {
  asciiToString,
  BACKSLASH,
  CR,
  DQUOTE,
  isDigit,
  LBRACE,
  LBRACKET,
  LF,
  LPAREN,
  PLUS,
  RBRACE,
  RBRACKET,
  RPAREN,
  SPACE,
  TAB,
} from './bytes.ts';

export const DEFAULT_MAX_LITERAL_BYTES = 32 * 1024 * 1024;
const MAX_UINT32 = 4294967295;

export type ImapToken =
  | { readonly kind: 'atom'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'quoted'; readonly value: string }
  | { readonly kind: 'literal'; readonly value: Uint8Array }
  | { readonly kind: 'lparen' }
  | { readonly kind: 'rparen' }
  | { readonly kind: 'lbracket' }
  | { readonly kind: 'rbracket' }
  | { readonly kind: 'plus' }
  | { readonly kind: 'nil' };

export type ImapFailure =
  | { readonly kind: 'no'; readonly text: string }
  | { readonly kind: 'bad'; readonly text: string }
  | { readonly kind: 'bye'; readonly text: string }
  | { readonly kind: 'closed' }
  | { readonly kind: 'protocol'; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly detail: string };

export type ImapResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ImapFailure };

export type LogicalLineSegment =
  | { readonly kind: 'text'; readonly bytes: Uint8Array }
  | { readonly kind: 'literal'; readonly bytes: Uint8Array };

export type LogicalLine = {
  readonly segments: readonly LogicalLineSegment[];
  readonly rawText: string;
};

export type ReadLineResume = {
  readonly resumeAt: number;
  readonly needBytes: number;
  readonly segments?: readonly LogicalLineSegment[];
  readonly textStart?: number;
  readonly pendingLiteral?: { readonly start: number; readonly end: number };
};

type ReadLineResult =
  | { readonly status: 'complete'; readonly line: LogicalLine; readonly consumedBytes: number }
  | {
      readonly status: 'incomplete';
      readonly resumeAt: number;
      readonly needBytes: number;
      readonly segments?: readonly LogicalLineSegment[];
      readonly textStart?: number;
      readonly pendingLiteral?: { readonly start: number; readonly end: number };
    }
  | { readonly status: 'failure'; readonly failure: ImapFailure };

const checkBareLf = (bytes: Uint8Array, start: number, end: number): ImapFailure | null => {
  for (let i = start; i < end; i++) {
    if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) {
      return { kind: 'protocol', detail: `Bare LF at index ${i}` };
    }
  }
  return null;
};

type LiteralHeaderResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly detail: string }
  | { readonly kind: 'valid'; readonly length: number; readonly braceIndex: number };

const parseLiteralHeader = (
  bytes: Uint8Array,
  textStart: number,
  crlfIndex: number,
  maxLiteralBytes: number,
): LiteralHeaderResult => {
  if (crlfIndex === 0) return { kind: 'none' };
  let i = crlfIndex - 1;
  if (bytes[i] !== RBRACE) return { kind: 'none' };
  i--;
  if (i >= textStart && bytes[i] === PLUS) {
    i--;
  }
  const digitsEnd = i + 1;
  while (i >= textStart && isDigit(bytes[i] ?? 0)) {
    i--;
  }
  if (i < textStart || bytes[i] !== LBRACE) {
    // A `{` anywhere before the closing `}` means a malformed literal header, not a plain line.
    for (let j = crlfIndex - 2; j >= textStart; j--) {
      if (bytes[j] === LBRACE) {
        return { kind: 'invalid', detail: 'Invalid literal header syntax' };
      }
    }
    return { kind: 'none' };
  }

  const braceIndex = i;
  const digitsStart = i + 1;
  if (digitsStart >= digitsEnd) {
    return { kind: 'invalid', detail: 'Empty literal length in literal header' };
  }

  const digitsStr = asciiToString(bytes.slice(digitsStart, digitsEnd));
  const num = Number.parseInt(digitsStr, 10);
  if (!Number.isSafeInteger(num) || num > MAX_UINT32) {
    return {
      kind: 'invalid',
      detail: `Literal length ${digitsStr} is not a valid 32-bit unsigned integer`,
    };
  }
  if (num > maxLiteralBytes) {
    return {
      kind: 'invalid',
      detail: `Literal of ${num} bytes exceeds maxLiteralBytes (${maxLiteralBytes})`,
    };
  }

  return { kind: 'valid', length: num, braceIndex };
};

export const readLogicalLine = (
  buffer: Uint8Array,
  maxLiteralBytes: number = DEFAULT_MAX_LITERAL_BYTES,
  resume?: ReadLineResume,
): ReadLineResult => {
  const segments: LogicalLineSegment[] = resume?.segments ? [...resume.segments] : [];
  let scanOffset = resume?.resumeAt ?? 0;
  let textStart = resume?.textStart ?? resume?.resumeAt ?? 0;

  if (resume?.pendingLiteral !== undefined) {
    const { start, end } = resume.pendingLiteral;
    if (buffer.length < end) {
      return {
        status: 'incomplete',
        resumeAt: scanOffset,
        needBytes: end,
        segments,
        textStart,
        pendingLiteral: resume.pendingLiteral,
      };
    }
    segments.push({
      kind: 'literal',
      bytes: buffer.slice(start, end),
    });
    scanOffset = end;
    textStart = end;
  }

  while (scanOffset < buffer.length) {
    let crlfIndex = -1;
    for (let i = scanOffset; i < buffer.length - 1; i++) {
      if (buffer[i] === CR && buffer[i + 1] === LF) {
        crlfIndex = i;
        break;
      }
    }

    if (crlfIndex === -1) {
      const lfFailure = checkBareLf(buffer, scanOffset, buffer.length);
      if (lfFailure !== null) return { status: 'failure', failure: lfFailure };
      const nextResumeAt = Math.max(textStart, buffer.length - 1);
      return {
        status: 'incomplete',
        resumeAt: nextResumeAt,
        needBytes: buffer.length + 1,
        segments,
        textStart,
      };
    }

    const lfFailure = checkBareLf(buffer, scanOffset, crlfIndex);
    if (lfFailure !== null) return { status: 'failure', failure: lfFailure };

    const headerResult = parseLiteralHeader(buffer, textStart, crlfIndex, maxLiteralBytes);

    if (headerResult.kind === 'invalid') {
      return {
        status: 'failure',
        failure: {
          kind: 'protocol',
          detail: headerResult.detail,
        },
      };
    }

    if (headerResult.kind === 'valid') {
      const braceIndex = headerResult.braceIndex;
      const literalLength = headerResult.length;

      if (braceIndex > textStart) {
        segments.push({ kind: 'text', bytes: buffer.slice(textStart, braceIndex) });
      }

      const literalDataStart = crlfIndex + 2;
      const literalDataEnd = literalDataStart + literalLength;

      if (buffer.length < literalDataEnd) {
        return {
          status: 'incomplete',
          resumeAt: crlfIndex,
          needBytes: literalDataEnd,
          segments,
          textStart: literalDataEnd,
          pendingLiteral: { start: literalDataStart, end: literalDataEnd },
        };
      }

      segments.push({
        kind: 'literal',
        bytes: buffer.slice(literalDataStart, literalDataEnd),
      });

      scanOffset = literalDataEnd;
      textStart = literalDataEnd;
    } else {
      if (crlfIndex >= textStart) {
        segments.push({ kind: 'text', bytes: buffer.slice(textStart, crlfIndex) });
      }
      const consumedBytes = crlfIndex + 2;

      let rawText = '';
      for (const seg of segments) {
        if (seg.kind === 'text') {
          rawText += asciiToString(seg.bytes);
        } else {
          rawText += `<literal:${seg.bytes.length}B>`;
        }
      }

      return {
        status: 'complete',
        line: { segments, rawText },
        consumedBytes,
      };
    }
  }

  return {
    status: 'incomplete',
    resumeAt: Math.max(textStart, buffer.length - 1),
    needBytes: buffer.length + 1,
    segments,
    textStart,
  };
};

const tokenizeTextSegment = (bytes: Uint8Array, tokens: ImapToken[]): ImapResult<void> => {
  let i = 0;
  const len = bytes.length;

  while (i < len) {
    const byte = bytes[i] ?? 0;

    if (byte === SPACE || byte === TAB || byte === CR || byte === LF) {
      i++;
      continue;
    }

    if (byte === LPAREN) {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }

    if (byte === RPAREN) {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }

    if (byte === LBRACKET) {
      tokens.push({ kind: 'lbracket' });
      i++;
      continue;
    }

    if (byte === RBRACKET) {
      tokens.push({ kind: 'rbracket' });
      i++;
      continue;
    }

    if (byte === DQUOTE) {
      i++;
      let quotedStr = '';
      let isTerminated = false;

      while (i < len) {
        const qb = bytes[i] ?? 0;
        if (qb === LF && (i === 0 || bytes[i - 1] !== CR)) {
          return { ok: false, reason: { kind: 'protocol', detail: 'Bare LF in quoted string' } };
        }
        if (qb === BACKSLASH) {
          i++;
          if (i >= len) {
            return {
              ok: false,
              reason: { kind: 'protocol', detail: 'Unterminated escape in quoted string' },
            };
          }
          quotedStr += String.fromCharCode(bytes[i] ?? 0);
          i++;
        } else if (qb === DQUOTE) {
          isTerminated = true;
          i++;
          break;
        } else {
          quotedStr += String.fromCharCode(qb);
          i++;
        }
      }

      if (!isTerminated) {
        return {
          ok: false,
          reason: { kind: 'protocol', detail: 'Unterminated quoted string' },
        };
      }

      tokens.push({ kind: 'quoted', value: quotedStr });
      continue;
    }

    if (byte === PLUS) {
      const next = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
      const isNextAtomChar =
        next !== 0 &&
        next !== SPACE &&
        next !== TAB &&
        next !== LPAREN &&
        next !== RPAREN &&
        next !== LBRACKET &&
        next !== RBRACKET &&
        next !== CR &&
        next !== LF;

      if (!isNextAtomChar) {
        tokens.push({ kind: 'plus' });
        i++;
        continue;
      }
    }

    const atomStart = i;
    while (i < len) {
      const b = bytes[i] ?? 0;
      if (
        b === SPACE ||
        b === TAB ||
        b === CR ||
        b === LF ||
        b === LPAREN ||
        b === RPAREN ||
        b === LBRACKET ||
        b === RBRACKET ||
        b === DQUOTE
      ) {
        break;
      }
      i++;
    }

    const atomStr = asciiToString(bytes.slice(atomStart, i));

    if (atomStr.toUpperCase() === 'NIL') {
      tokens.push({ kind: 'nil' });
    } else if (/^\d+$/.test(atomStr)) {
      const num = Number.parseInt(atomStr, 10);
      // RFC 9051's `number` is 32-bit, but Gmail's X-GM-THRID is 64-bit and arrives bare.
      if (num > MAX_UINT32) {
        tokens.push({ kind: 'atom', value: atomStr });
      } else {
        tokens.push({ kind: 'number', value: num });
      }
    } else {
      tokens.push({ kind: 'atom', value: atomStr });
    }
  }

  return { ok: true, value: undefined };
};

export const tokenizeLogicalLine = (line: LogicalLine): ImapResult<readonly ImapToken[]> => {
  const tokens: ImapToken[] = [];

  for (const seg of line.segments) {
    if (seg.kind === 'literal') {
      tokens.push({ kind: 'literal', value: seg.bytes });
    } else {
      const result = tokenizeTextSegment(seg.bytes, tokens);
      if (!result.ok) return result;
    }
  }

  return { ok: true, value: tokens };
};
