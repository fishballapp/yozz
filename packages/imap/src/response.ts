import { asciiToString } from './bytes.ts';
import { type ImapFetchItem, parseFetchItems } from './envelope.ts';
import type { ImapResult, ImapToken } from './tokenizer.ts';
import { decodeModifiedUtf7 } from './utf7.ts';

export type ImapMailbox = {
  readonly name: string;
  readonly delimiter: string | null;
  readonly attributes: readonly string[];
};

export type ImapResponseCode =
  | { readonly kind: 'capability'; readonly capabilities: readonly string[] }
  | { readonly kind: 'permanentFlags'; readonly flags: readonly string[] }
  | { readonly kind: 'uidValidity'; readonly value: number }
  | { readonly kind: 'uidNext'; readonly value: number }
  | { readonly kind: 'readOnly' }
  | { readonly kind: 'readWrite' }
  | { readonly kind: 'alert' }
  | { readonly kind: 'other'; readonly code: string; readonly args: readonly string[] };

export type ImapUntagged =
  | {
      readonly kind: 'status';
      readonly status: 'OK' | 'NO' | 'BAD' | 'BYE' | 'PREAUTH';
      readonly code: ImapResponseCode | null;
      readonly text: string;
    }
  | { readonly kind: 'capability'; readonly capabilities: readonly string[] }
  | { readonly kind: 'list'; readonly mailbox: ImapMailbox }
  | { readonly kind: 'flags'; readonly flags: readonly string[] }
  | { readonly kind: 'exists'; readonly count: number }
  | { readonly kind: 'recent'; readonly count: number }
  | { readonly kind: 'expunge'; readonly seq: number }
  | { readonly kind: 'fetch'; readonly seq: number; readonly items: readonly ImapFetchItem[] }
  | { readonly kind: 'search'; readonly uids: readonly number[] }
  | { readonly kind: 'unknown'; readonly name: string; readonly rest: readonly string[] };

export type ImapTagged = {
  readonly kind: 'tagged';
  readonly tag: string;
  readonly status: 'OK' | 'NO' | 'BAD';
  readonly code: ImapResponseCode | null;
  readonly text: string;
};

export type ImapContinuation = {
  readonly kind: 'continuation';
  readonly text: string;
};

export type ImapResponse =
  | ImapTagged
  | { readonly kind: 'untagged'; readonly untagged: ImapUntagged }
  | ImapContinuation;

const tokenToString = (token: ImapToken | undefined): string | null => {
  if (token === undefined || token.kind === 'nil') return null;
  if (token.kind === 'quoted' || token.kind === 'atom') return token.value;
  if (token.kind === 'number') return String(token.value);
  if (token.kind === 'literal') return asciiToString(token.value);
  return null;
};

const tokensToText = (tokens: readonly ImapToken[], start: number): string => {
  const parts: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    if (tok.kind === 'atom' || tok.kind === 'quoted') parts.push(tok.value);
    else if (tok.kind === 'number') parts.push(String(tok.value));
    else if (tok.kind === 'literal') parts.push(asciiToString(tok.value));
    else if (tok.kind === 'plus') parts.push('+');
    else if (tok.kind === 'nil') parts.push('NIL');
    else if (tok.kind === 'lparen') parts.push('(');
    else if (tok.kind === 'rparen') parts.push(')');
    else if (tok.kind === 'lbracket') parts.push('[');
    else if (tok.kind === 'rbracket') parts.push(']');
  }
  return parts.join(' ');
};

const parseResponseCode = (
  tokens: readonly ImapToken[],
  start: number,
): { code: ImapResponseCode; nextIndex: number } | null => {
  if (tokens[start]?.kind !== 'lbracket') return null;
  let idx = start + 1;

  const codeTok = tokens[idx];
  if (codeTok?.kind !== 'atom') return null;
  const codeName = codeTok.value.toUpperCase();
  idx++;

  if (codeName === 'CAPABILITY') {
    const capabilities: string[] = [];
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') {
      const capTok = tokens[idx];
      if (capTok?.kind === 'atom') capabilities.push(capTok.value);
      idx++;
    }
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'capability', capabilities }, nextIndex: idx };
  }

  if (codeName === 'PERMANENTFLAGS') {
    const flags: string[] = [];
    if (tokens[idx]?.kind === 'lparen') {
      idx++;
      while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
        const flagTok = tokens[idx];
        if (flagTok?.kind === 'atom') flags.push(flagTok.value);
        idx++;
      }
      if (tokens[idx]?.kind === 'rparen') idx++;
    }
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') {
      idx++;
    }
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'permanentFlags', flags }, nextIndex: idx };
  }

  if (codeName === 'UIDVALIDITY') {
    const valTok = tokens[idx];
    const value = valTok?.kind === 'number' ? valTok.value : 0;
    idx++;
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') idx++;
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'uidValidity', value }, nextIndex: idx };
  }

  if (codeName === 'UIDNEXT') {
    const valTok = tokens[idx];
    const value = valTok?.kind === 'number' ? valTok.value : 0;
    idx++;
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') idx++;
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'uidNext', value }, nextIndex: idx };
  }

  if (codeName === 'READ-ONLY') {
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') idx++;
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'readOnly' }, nextIndex: idx };
  }

  if (codeName === 'READ-WRITE') {
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') idx++;
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'readWrite' }, nextIndex: idx };
  }

  if (codeName === 'ALERT') {
    while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') idx++;
    if (tokens[idx]?.kind === 'rbracket') idx++;
    return { code: { kind: 'alert' }, nextIndex: idx };
  }

  const args: string[] = [];
  while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') {
    const str = tokenToString(tokens[idx]);
    if (str !== null) args.push(str);
    idx++;
  }
  if (tokens[idx]?.kind === 'rbracket') idx++;
  return { code: { kind: 'other', code: codeName, args }, nextIndex: idx };
};

export const parseResponse = (tokens: readonly ImapToken[]): ImapResult<ImapResponse> => {
  if (tokens.length === 0) {
    return { ok: false, reason: { kind: 'protocol', detail: 'Empty response line' } };
  }

  const first = tokens[0];
  if (first === undefined) {
    return { ok: false, reason: { kind: 'protocol', detail: 'Empty token stream' } };
  }

  if (first.kind === 'plus') {
    const text = tokensToText(tokens, 1);
    return { ok: true, value: { kind: 'continuation', text } };
  }

  if (first.kind === 'atom' && first.value === '*') {
    const second = tokens[1];
    if (second === undefined) {
      return { ok: false, reason: { kind: 'protocol', detail: 'Bare * untagged marker' } };
    }

    if (second.kind === 'atom') {
      const upper = second.value.toUpperCase();
      if (
        upper === 'OK' ||
        upper === 'NO' ||
        upper === 'BAD' ||
        upper === 'BYE' ||
        upper === 'PREAUTH'
      ) {
        let idx = 2;
        let code: ImapResponseCode | null = null;
        if (tokens[idx]?.kind === 'lbracket') {
          const codeResult = parseResponseCode(tokens, idx);
          if (codeResult !== null) {
            code = codeResult.code;
            idx = codeResult.nextIndex;
          }
        }
        const text = tokensToText(tokens, idx);
        return {
          ok: true,
          value: {
            kind: 'untagged',
            untagged: {
              kind: 'status',
              status: upper,
              code,
              text,
            },
          },
        };
      }

      if (upper === 'CAPABILITY') {
        const capabilities: string[] = [];
        for (let i = 2; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok?.kind === 'atom') capabilities.push(tok.value);
        }
        return {
          ok: true,
          value: {
            kind: 'untagged',
            untagged: { kind: 'capability', capabilities },
          },
        };
      }

      if (upper === 'FLAGS') {
        const flags: string[] = [];
        let idx = 2;
        if (tokens[idx]?.kind === 'lparen') {
          idx++;
          while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
            const tok = tokens[idx];
            if (tok?.kind === 'atom') flags.push(tok.value);
            idx++;
          }
        }
        return {
          ok: true,
          value: {
            kind: 'untagged',
            untagged: { kind: 'flags', flags },
          },
        };
      }

      if (upper === 'LIST') {
        let idx = 2;
        const attributes: string[] = [];
        if (tokens[idx]?.kind === 'lparen') {
          idx++;
          while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
            const tok = tokens[idx];
            if (tok?.kind === 'atom') attributes.push(tok.value);
            idx++;
          }
          if (tokens[idx]?.kind === 'rparen') idx++;
        }

        const delimiter = tokenToString(tokens[idx]);
        idx++;

        const rawName = tokenToString(tokens[idx]) ?? '';
        const name = decodeModifiedUtf7(rawName);

        return {
          ok: true,
          value: {
            kind: 'untagged',
            untagged: {
              kind: 'list',
              mailbox: { name, delimiter, attributes },
            },
          },
        };
      }

      if (upper === 'SEARCH') {
        const uids: number[] = [];
        for (let i = 2; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok?.kind === 'number') uids.push(tok.value);
        }
        return {
          ok: true,
          value: {
            kind: 'untagged',
            untagged: { kind: 'search', uids },
          },
        };
      }
    }

    if (second.kind === 'number') {
      const num = second.value;
      const third = tokens[2];
      if (third?.kind === 'atom') {
        const verb = third.value.toUpperCase();
        if (verb === 'EXISTS') {
          return {
            ok: true,
            value: {
              kind: 'untagged',
              untagged: { kind: 'exists', count: num },
            },
          };
        }
        if (verb === 'RECENT') {
          return {
            ok: true,
            value: {
              kind: 'untagged',
              untagged: { kind: 'recent', count: num },
            },
          };
        }
        if (verb === 'EXPUNGE') {
          return {
            ok: true,
            value: {
              kind: 'untagged',
              untagged: { kind: 'expunge', seq: num },
            },
          };
        }
        if (verb === 'FETCH') {
          const fetchResult = parseFetchItems(tokens, 3);
          return {
            ok: true,
            value: {
              kind: 'untagged',
              untagged: {
                kind: 'fetch',
                seq: num,
                items: fetchResult.items,
              },
            },
          };
        }
      }
    }

    const name = second.kind === 'atom' ? second.value : String(tokenToString(second));
    const rest: string[] = [];
    for (let i = 2; i < tokens.length; i++) {
      const str = tokenToString(tokens[i]);
      if (str !== null) rest.push(str);
    }
    return {
      ok: true,
      value: {
        kind: 'untagged',
        untagged: { kind: 'unknown', name, rest },
      },
    };
  }

  if (first.kind === 'atom') {
    const tag = first.value;
    const second = tokens[1];
    if (second?.kind === 'atom') {
      const statusUpper = second.value.toUpperCase();
      if (statusUpper === 'OK' || statusUpper === 'NO' || statusUpper === 'BAD') {
        let idx = 2;
        let code: ImapResponseCode | null = null;
        if (tokens[idx]?.kind === 'lbracket') {
          const codeResult = parseResponseCode(tokens, idx);
          if (codeResult !== null) {
            code = codeResult.code;
            idx = codeResult.nextIndex;
          }
        }
        const text = tokensToText(tokens, idx);
        return {
          ok: true,
          value: {
            kind: 'tagged',
            tag,
            status: statusUpper,
            code,
            text,
          },
        };
      }
    }
  }

  return {
    ok: false,
    reason: {
      kind: 'protocol',
      detail: `Unrecognised IMAP response line starting with ${first.kind}`,
    },
  };
};
