/**
 * Parsers for IMAP FETCH items: ENVELOPE, FLAGS, INTERNALDATE, RFC822.SIZE, BODYSTRUCTURE.
 */

import { asciiToString, stringToBytes } from './bytes.ts';
import { decodeRfc2047 } from './rfc2047.ts';
import type { ImapToken } from './tokenizer.ts';

export type ImapAddress = {
  readonly name: string | null;
  readonly mailbox: string | null;
  readonly host: string | null;
};

export type ImapEnvelope = {
  readonly date: string | null;
  readonly subject: string | null;
  readonly subjectRaw: string | null;
  readonly from: readonly ImapAddress[];
  readonly sender: readonly ImapAddress[];
  readonly replyTo: readonly ImapAddress[];
  readonly to: readonly ImapAddress[];
  readonly cc: readonly ImapAddress[];
  readonly bcc: readonly ImapAddress[];
  readonly inReplyTo: string | null;
  readonly messageId: string | null;
};

export type ImapFetchItem =
  | { readonly kind: 'flags'; readonly flags: readonly string[] }
  | { readonly kind: 'envelope'; readonly envelope: ImapEnvelope }
  | { readonly kind: 'internalDate'; readonly date: string }
  | { readonly kind: 'size'; readonly size: number }
  | { readonly kind: 'uid'; readonly uid: number }
  | { readonly kind: 'body'; readonly section: string; readonly bytes: Uint8Array | null }
  | { readonly kind: 'bodyStructure'; readonly parts: readonly string[] }
  /** Gmail's `X-GM-THRID`: 64-bit, so kept as its decimal digits. */
  | { readonly kind: 'gmailThreadId'; readonly id: string }
  | { readonly kind: 'other'; readonly name: string };

const tokenToString = (token: ImapToken | undefined): string | null => {
  if (token === undefined || token.kind === 'nil') return null;
  if (token.kind === 'quoted' || token.kind === 'atom') return token.value;
  if (token.kind === 'number') return String(token.value);
  if (token.kind === 'literal') return asciiToString(token.value);
  return null;
};

/**
 * Parses a single address tuple `(name adl mailbox host)` and advances index past `)`.
 */
const parseAddressTuple = (
  tokens: readonly ImapToken[],
  start: number,
): { address: ImapAddress | 'group-start' | 'group-end'; nextIndex: number } | null => {
  let idx = start;
  if (tokens[idx]?.kind !== 'lparen') return null;
  idx++;

  const rawName = tokenToString(tokens[idx]);
  idx++;
  // Source route (adl) is ignored
  idx++;
  const rawMailbox = tokenToString(tokens[idx]);
  idx++;
  const rawHost = tokenToString(tokens[idx]);
  idx++;

  // Consume up to matching ')'
  while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
    idx++;
  }
  if (tokens[idx]?.kind === 'rparen') idx++;

  const name = rawName !== null ? decodeRfc2047(rawName) : null;
  const mailbox = rawMailbox;
  const host = rawHost;

  if (host === null) {
    if (mailbox !== null) return { address: 'group-start', nextIndex: idx };
    return { address: 'group-end', nextIndex: idx };
  }

  return {
    address: { name, mailbox, host },
    nextIndex: idx,
  };
};

/**
 * Parses an address list `( (addr1) (addr2) ... )` or `NIL`.
 * Flattening groups to their member addresses.
 */
export const parseAddressList = (
  tokens: readonly ImapToken[],
  start: number,
): { addresses: readonly ImapAddress[]; nextIndex: number } => {
  const first = tokens[start];
  if (first === undefined || first.kind === 'nil') {
    return { addresses: [], nextIndex: start + 1 };
  }

  if (first.kind !== 'lparen') {
    return { addresses: [], nextIndex: start + 1 };
  }

  let idx = start + 1;
  const addresses: ImapAddress[] = [];

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === undefined || tok.kind === 'rparen') {
      idx++;
      break;
    }

    if (tok.kind === 'lparen') {
      const parsed = parseAddressTuple(tokens, idx);
      if (parsed === null) {
        idx++;
      } else {
        if (parsed.address !== 'group-start' && parsed.address !== 'group-end') {
          addresses.push(parsed.address);
        }
        idx = parsed.nextIndex;
      }
    } else {
      idx++;
    }
  }

  return { addresses, nextIndex: idx };
};

/**
 * Parses an ENVELOPE structure:
 * `(date subject from sender reply-to to cc bcc in-reply-to message-id)`
 */
export const parseEnvelope = (
  tokens: readonly ImapToken[],
  start: number,
): { envelope: ImapEnvelope; nextIndex: number } | null => {
  if (tokens[start]?.kind !== 'lparen') return null;
  let idx = start + 1;

  // 1. date
  const date = tokenToString(tokens[idx]);
  idx++;

  // 2. subject
  const subjectRaw = tokenToString(tokens[idx]);
  const subject = subjectRaw !== null ? decodeRfc2047(subjectRaw) : null;
  idx++;

  // 3. from
  const fromResult = parseAddressList(tokens, idx);
  const from = fromResult.addresses;
  idx = fromResult.nextIndex;

  // 4. sender
  const senderResult = parseAddressList(tokens, idx);
  const sender = senderResult.addresses;
  idx = senderResult.nextIndex;

  // 5. reply-to
  const replyToResult = parseAddressList(tokens, idx);
  const replyTo = replyToResult.addresses;
  idx = replyToResult.nextIndex;

  // 6. to
  const toResult = parseAddressList(tokens, idx);
  const to = toResult.addresses;
  idx = toResult.nextIndex;

  // 7. cc
  const ccResult = parseAddressList(tokens, idx);
  const cc = ccResult.addresses;
  idx = ccResult.nextIndex;

  // 8. bcc
  const bccResult = parseAddressList(tokens, idx);
  const bcc = bccResult.addresses;
  idx = bccResult.nextIndex;

  // 9. in-reply-to
  const inReplyTo = tokenToString(tokens[idx]);
  idx++;

  // 10. message-id
  const messageId = tokenToString(tokens[idx]);
  idx++;

  // Skip any trailing fields up to matching ')'
  while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
    idx++;
  }
  if (tokens[idx]?.kind === 'rparen') idx++;

  return {
    envelope: {
      date,
      subject,
      subjectRaw,
      from,
      sender,
      replyTo,
      to,
      cc,
      bcc,
      inReplyTo,
      messageId,
    },
    nextIndex: idx,
  };
};

/**
 * Parses BODYSTRUCTURE, extracting only the list of MIME parts (e.g. ['TEXT/PLAIN', 'TEXT/HTML']).
 */
export const parseBodyStructureParts = (
  tokens: readonly ImapToken[],
  start: number,
): { parts: readonly string[]; nextIndex: number } => {
  if (tokens[start]?.kind !== 'lparen') {
    return { parts: [], nextIndex: start + 1 };
  }

  let idx = start + 1;
  const parts: string[] = [];

  // Check if first element is '(' (multipart) or string (singlepart)
  const first = tokens[idx];

  if (first?.kind === 'lparen') {
    // Multipart: list of subparts followed by subtype
    while (idx < tokens.length && tokens[idx]?.kind === 'lparen') {
      const child = parseBodyStructureParts(tokens, idx);
      parts.push(...child.parts);
      idx = child.nextIndex;
    }

    // Skip multipart subtype and remaining params up to matching ')'
    let depth = 1;
    while (idx < tokens.length && depth > 0) {
      if (tokens[idx]?.kind === 'lparen') depth++;
      else if (tokens[idx]?.kind === 'rparen') depth--;
      idx++;
    }

    return { parts, nextIndex: idx };
  }

  // Singlepart: media-type subtype params ...
  const mediaType = tokenToString(tokens[idx]) ?? 'APPLICATION';
  idx++;
  const subType = tokenToString(tokens[idx]) ?? 'OCTET-STREAM';
  idx++;

  parts.push(`${mediaType.toUpperCase()}/${subType.toUpperCase()}`);

  // Skip remaining params up to matching ')'
  let depth = 1;
  while (idx < tokens.length && depth > 0) {
    if (tokens[idx]?.kind === 'lparen') depth++;
    else if (tokens[idx]?.kind === 'rparen') depth--;
    idx++;
  }

  return { parts, nextIndex: idx };
};

/**
 * Parses items inside a FETCH response `(...)`.
 */
export const parseFetchItems = (
  tokens: readonly ImapToken[],
  start: number,
): { items: readonly ImapFetchItem[]; nextIndex: number } => {
  if (tokens[start]?.kind !== 'lparen') {
    return { items: [], nextIndex: start + 1 };
  }

  let idx = start + 1;
  const items: ImapFetchItem[] = [];

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok === undefined || tok.kind === 'rparen') {
      idx++;
      break;
    }

    if (tok.kind === 'atom') {
      const itemName = tok.value.toUpperCase();
      idx++;

      if (itemName === 'UID') {
        const uidTok = tokens[idx];
        const uid = uidTok?.kind === 'number' ? uidTok.value : 0;
        idx++;
        items.push({ kind: 'uid', uid });
      } else if (itemName === 'RFC822.SIZE') {
        const sizeTok = tokens[idx];
        const size = sizeTok?.kind === 'number' ? sizeTok.value : 0;
        idx++;
        items.push({ kind: 'size', size });
      } else if (itemName === 'INTERNALDATE') {
        const dateStr = tokenToString(tokens[idx]) ?? '';
        idx++;
        items.push({ kind: 'internalDate', date: dateStr });
      } else if (itemName === 'FLAGS') {
        if (tokens[idx]?.kind === 'lparen') {
          idx++;
          const flags: string[] = [];
          while (idx < tokens.length && tokens[idx]?.kind !== 'rparen') {
            const flagTok = tokens[idx];
            if (flagTok?.kind === 'atom') flags.push(flagTok.value);
            idx++;
          }
          if (tokens[idx]?.kind === 'rparen') idx++;
          items.push({ kind: 'flags', flags });
        } else {
          idx++;
        }
      } else if (itemName === 'ENVELOPE') {
        const envResult = parseEnvelope(tokens, idx);
        if (envResult !== null) {
          items.push({ kind: 'envelope', envelope: envResult.envelope });
          idx = envResult.nextIndex;
        } else {
          idx++;
        }
      } else if (itemName === 'BODYSTRUCTURE' || itemName === 'BODY' || itemName === 'BODY.PEEK') {
        if (tokens[idx]?.kind === 'lparen') {
          const bsResult = parseBodyStructureParts(tokens, idx);
          items.push({ kind: 'bodyStructure', parts: bsResult.parts });
          idx = bsResult.nextIndex;
        } else if (tokens[idx]?.kind === 'lbracket') {
          idx++; // consume '['
          const sectionParts: string[] = [];
          while (idx < tokens.length && tokens[idx]?.kind !== 'rbracket') {
            const secTok = tokens[idx];
            if (secTok !== undefined) {
              if (secTok.kind === 'atom' || secTok.kind === 'quoted') {
                sectionParts.push(secTok.value);
              } else if (secTok.kind === 'number') {
                sectionParts.push(String(secTok.value));
              } else if (secTok.kind === 'lparen') {
                sectionParts.push('(');
              } else if (secTok.kind === 'rparen') {
                sectionParts.push(')');
              } else if (secTok.kind === 'nil') {
                sectionParts.push('NIL');
              } else if (secTok.kind === 'literal') {
                sectionParts.push(asciiToString(secTok.value));
              }
            }
            idx++;
          }
          if (tokens[idx]?.kind === 'rbracket') idx++; // consume ']'

          const section = sectionParts.join(' ');

          // Optional <origin> partial, e.g. <0.1024> or <0>
          const originTok = tokens[idx];
          if (originTok?.kind === 'atom' && /^<\d+(\.\d+)?>$/.test(originTok.value)) {
            idx++;
          }

          const bodyTok = tokens[idx];
          idx++;

          let bytes: Uint8Array | null = null;
          if (bodyTok?.kind === 'literal') {
            bytes = bodyTok.value;
          } else if (bodyTok?.kind === 'quoted' || bodyTok?.kind === 'atom') {
            bytes = stringToBytes(bodyTok.value);
          } else if (bodyTok?.kind === 'nil') {
            bytes = null;
          }

          items.push({ kind: 'body', section, bytes });
        } else {
          idx++;
        }
      } else if (itemName === 'X-GM-THRID') {
        const id = tokenToString(tokens[idx]);
        idx++;
        if (id !== null && /^\d+$/.test(id)) items.push({ kind: 'gmailThreadId', id });
      } else {
        items.push({ kind: 'other', name: itemName });
        idx++;
      }
    } else {
      idx++;
    }
  }

  return { items, nextIndex: idx };
};
