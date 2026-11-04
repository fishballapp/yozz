import { decodeRfc2047 } from './rfc2047.ts';
import type { ImapToken } from './tokenizer.ts';

/** A parenthesised list and what is in it. */
type ListNode = { readonly kind: 'list'; readonly items: BodyNode[] };
type BodyNode = ListNode | Exclude<ImapToken, { readonly kind: 'lparen' | 'rparen' }>;

/** Past this a structure is not mail anyone wrote, and a name in it is not worth finding. */
const MAX_DEPTH = 32;
const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 255;

const readList = (
  tokens: readonly ImapToken[],
  start: number,
): { readonly list: ListNode | null; readonly nextIndex: number } => {
  if (tokens[start]?.kind !== 'lparen') return { list: null, nextIndex: start + 1 };
  const list: ListNode = { kind: 'list', items: [] };
  const open = [list];
  let idx = start + 1;
  while (idx < tokens.length && open.length > 0) {
    const token = tokens[idx];
    idx++;
    const top = open.at(-1);
    if (token === undefined || top === undefined) break;
    if (token.kind === 'rparen') {
      open.pop();
    } else if (token.kind === 'lparen') {
      const child: ListNode = { kind: 'list', items: [] };
      top.items.push(child);
      open.push(child);
    } else {
      top.items.push(token);
    }
  }
  return { list, nextIndex: idx };
};

/** A server may send a name as raw bytes; they are UTF-8 unless they cannot be. */
const decodeRawName = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
};

const textOf = (node: BodyNode | undefined): string | null => {
  if (node?.kind === 'literal') return decodeRawName(node.value);
  // The tokenizer keeps a quoted string's bytes one per character.
  if (node?.kind === 'quoted') return decodeRawName(Uint8Array.from(node.value, byteOf));
  return node?.kind === 'atom' ? node.value : null;
};

const byteOf = (character: string) => character.charCodeAt(0);

/** `("KEY" "value" …)` by lowercased key. */
const paramsIn = (node: BodyNode | undefined): ReadonlyMap<string, string> => {
  if (node?.kind !== 'list') return new Map();
  return new Map(
    node.items.flatMap((key, index) => {
      const value = textOf(node.items[index + 1]);
      const name = index % 2 === 0 ? textOf(key) : null;
      return name === null || value === null ? [] : [[name.toLowerCase(), value] as const];
    }),
  );
};

/** RFC 2231 §4 percent-encoding, as bytes; null when an escape is broken. */
const percentDecoded = (text: string): number[] | null => {
  const bytes = new TextEncoder().encode(text);
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    if (byte !== 0x25) {
      out.push(byte);
      continue;
    }
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);
    if (!/^[0-9a-fA-F]{2}$/u.test(hex)) return null;
    out.push(Number.parseInt(hex, 16));
    i += 2;
  }
  return out;
};

const decodedIn = (bytes: readonly number[], charset: string): string | null => {
  try {
    return new TextDecoder(charset === '' ? 'utf-8' : charset, { fatal: true }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return null;
  }
};

/**
 * RFC 2231's `key*`, `key*0`, `key*0*`, `key*1`…: the sections in order, their bytes joined before
 * the charset decodes them, since a character may straddle two. Null when absent or odd.
 */
const extendedParam = (params: ReadonlyMap<string, string>, key: string): string | null => {
  const sections = [...params].flatMap(([name, value]) => {
    if (name === `${key}*`) return [{ index: 0, isEncoded: true, value }];
    if (!name.startsWith(`${key}*`)) return [];
    const suffix = /^(\d{1,3})(\*?)$/u.exec(name.slice(key.length + 1));
    return suffix === null
      ? []
      : [{ index: Number(suffix[1]), isEncoded: suffix[2] === '*', value }];
  });
  const ordered = sections.toSorted((a, b) => a.index - b.index);
  const [first] = ordered;
  if (first === undefined || ordered.some(({ index }, at) => index !== at)) return null;
  const opening = first.isEncoded ? /^([^']*)'[^']*'(.*)$/su.exec(first.value) : null;
  if (first.isEncoded && opening === null) return null;
  const bytes = ordered.map(({ isEncoded, value }, at) => {
    const text = at === 0 && opening !== null ? (opening[2] ?? '') : value;
    return isEncoded ? percentDecoded(text) : [...new TextEncoder().encode(text)];
  });
  if (bytes.some(section => section === null)) return null;
  const decoded = decodedIn(
    bytes.flatMap(section => section ?? []),
    opening?.[1] ?? '',
  );
  // Sections that were never encoded may still hold the RFC 2047 words some mailers write.
  return decoded === null || first.isEncoded ? decoded : decodeRfc2047(decoded);
};

const paramNamed = (params: ReadonlyMap<string, string>, key: string): string | null => {
  const plain = params.get(key);
  return extendedParam(params, key) ?? (plain === undefined ? null : decodeRfc2047(plain));
};

/** The disposition's file name wins over the type's older `name`. Anything odd is no name. */
const partName = (
  disposition: ReadonlyMap<string, string>,
  params: ReadonlyMap<string, string>,
): string | null => {
  const name = (paramNamed(disposition, 'filename') ?? paramNamed(params, 'name') ?? '').trim();
  return name === '' || name.length > MAX_NAME_LENGTH ? null : name;
};

/** RFC 9051 body-type-1part: where the disposition sits differs by the part's type. */
const dispositionAt = (type: string, subtype: string) => {
  if (type === 'TEXT') return 9;
  return type === 'MESSAGE' && ['RFC822', 'GLOBAL'].includes(subtype) ? 11 : 8;
};

const namesIn = (node: BodyNode | undefined, depth: number): readonly string[] => {
  if (node?.kind !== 'list' || depth > MAX_DEPTH) return [];
  const [first, second] = node.items;
  if (first?.kind === 'list') {
    return node.items.flatMap(child => namesIn(child, depth + 1));
  }
  const type = textOf(first)?.toUpperCase() ?? '';
  const subtype = textOf(second)?.toUpperCase() ?? '';
  const disposition = node.items[dispositionAt(type, subtype)];
  const own = partName(
    paramsIn(disposition?.kind === 'list' ? disposition.items[1] : undefined),
    paramsIn(node.items[2]),
  );
  // A forwarded message carries its own attachments, as the body after its envelope says.
  const nested = dispositionAt(type, subtype) === 11 ? namesIn(node.items[8], depth + 1) : [];
  return [...(own === null ? [] : [own]), ...nested];
};

/**
 * The names a message's parts carry, from a `BODYSTRUCTURE` or `BODY` response: `filename` or `name`
 * in the plain, RFC 2231 and RFC 2047 forms, once each, in part order. Total: what cannot be read
 * is no name, never a failure.
 */
export const parseBodyStructure = (
  tokens: readonly ImapToken[],
  start: number,
): { readonly attachmentNames: readonly string[]; readonly nextIndex: number } => {
  const { list, nextIndex } = readList(tokens, start);
  return {
    attachmentNames: [...new Set(namesIn(list ?? undefined, 0))].slice(0, MAX_NAMES),
    nextIndex,
  };
};
