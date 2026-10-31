import { addressParser } from 'postal-mime';
import { getDomain } from 'tldts';
import {
  bytesOf,
  type Canonicalization,
  canonicalBody,
  canonicalHeader,
  type HeaderField,
  type SplitMessage,
  splitMessage,
} from './dkim-canonical.ts';

/**
 * Whether a message's From is vouched for by a DKIM signature (RFC 6376) the reader checks itself:
 * valid, and signed by the From domain's organisation, as DMARC's relaxed alignment reads it. Works
 * for mail from any server, since it needs only the raw message and the signer's key from DNS.
 * Facts and traps: docs/knowledge/dkim.md.
 */

/** TXT records at `name`, each record's strings already joined; [] when the name has none; null when the lookup itself failed. */
export type TxtLookup = (name: string) => Promise<readonly string[] | null>;

/** Why a message is unverified: for tests and debugging, never shown as a verdict. */
export type UnverifiedReason =
  /** A CR outside CRLF, or a line that is neither a field nor a fold: other parsers may read other headers. */
  | 'malformed-headers'
  | 'no-signature'
  /** DMARC reads exactly one author: one From field, one mailbox in it, on a plain host name. */
  | 'from-not-single'
  /** The signature's tag list is unreadable or misses a required tag. */
  | 'malformed'
  /** An algorithm or canonicalisation this does not speak. */
  | 'unsupported'
  /** rsa-sha1, which RFC 8301 says not to accept. */
  | 'weak-algorithm'
  | 'from-not-signed'
  /** A Subject or Reply-To `h=` does not sign, or a second, unsigned Content-Type or Content-Transfer-Encoding. */
  | 'unsigned-header'
  /** `d=` is not the From domain's organisation (or, under a key's `t=s`, the From domain itself). */
  | 'not-aligned'
  /** `l=` is not the whole body: anything after it would be unsigned. */
  | 'partial-body'
  | 'body-changed'
  /** The lookup failed, or the name holds no DKIM key record. */
  | 'key-unavailable'
  /** An empty `p=`. */
  | 'key-revoked'
  /** The record or its key is unreadable, or the record's `k=`, `h=` or `s=` rules this signature out. */
  | 'key-invalid'
  /** RSA under 1024 bits. */
  | 'weak-key'
  | 'bad-signature';

/**
 * Two outcomes only: a forger can strip a signature, and lists and forwards break real ones, so
 * nothing here calls mail forged. `reason` is for tests and debugging.
 *
 * Callers must compare `from` with the address they show (IMAP's ENVELOPE) and treat a mismatch as
 * unverified: postal-mime's address parser misreads RFC 5322 comments and nested angle brackets,
 * and that comparison, not this module, is what catches it.
 */
export type DkimVerdict =
  | {
      readonly status: 'verified';
      /** The single From mailbox, as written. */
      readonly from: string;
      /** The signing domain, `d=`. */
      readonly domain: string;
    }
  | { readonly status: 'unverified'; readonly reason: UnverifiedReason };

/** Each signature costs a DNS lookup and a verify, and the message is the sender's to write. */
const MAX_SIGNATURES = 5;

const MIN_RSA_BITS = 1024;

const WHITESPACE = /[ \t\r\n]+/g;

type Algorithm = {
  /** The key record's `k=`. */
  readonly keyType: string;
  /** The `p=` bytes as a key, or why they cannot be one. */
  readonly importKey: (key: Uint8Array<ArrayBuffer>) => Promise<CryptoKey | UnverifiedReason>;
  readonly verify: (
    key: CryptoKey,
    signature: Uint8Array<ArrayBuffer>,
    signed: Uint8Array<ArrayBuffer>,
  ) => Promise<boolean>;
};

const RSA = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** rsaEncryption with NULL parameters: the AlgorithmIdentifier an SPKI wraps an RSA key in. */
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.fromHex('300d06092a864886f70d0101010500');

const der = (tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> => {
  const length = (() => {
    if (content.length < 0x80) return [content.length];
    const bytes: number[] = [];
    for (let rest = content.length; rest > 0; rest = Math.floor(rest / 0x100)) {
      bytes.unshift(rest % 0x100);
    }
    return [0x80 | bytes.length, ...bytes];
  })();
  return new Uint8Array([tag, ...length, ...content]);
};

/**
 * An RSA `p=` is SPKI DER, or from some publishers a bare PKCS#1 RSAPublicKey, which this wraps in
 * SPKI. Both open with a SEQUENCE: inside it, SPKI starts with its AlgorithmIdentifier SEQUENCE,
 * PKCS#1 with the modulus INTEGER.
 */
const asSpki = (key: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => {
  const lengthByte = key[1] ?? 0;
  const contentStart = lengthByte < 0x80 ? 2 : 2 + (lengthByte & 0x7f);
  if (key[0] !== 0x30 || key[contentStart] !== 0x02) return key;
  return der(
    0x30,
    new Uint8Array([...RSA_ALGORITHM_IDENTIFIER, ...der(0x03, new Uint8Array([0, ...key]))]),
  );
};

const ALGORITHMS: Readonly<Record<string, Algorithm>> = {
  'rsa-sha256': {
    keyType: 'rsa',
    importKey: async key => {
      const imported = await crypto.subtle
        .importKey('spki', asSpki(key), RSA, false, ['verify'])
        .catch(() => null);
      if (imported === null) return 'key-invalid';
      const { algorithm } = imported;
      const isLongEnough =
        'modulusLength' in algorithm &&
        typeof algorithm.modulusLength === 'number' &&
        algorithm.modulusLength >= MIN_RSA_BITS;
      return isLongEnough ? imported : 'weak-key';
    },
    verify: (key, signature, signed) =>
      crypto.subtle.verify(RSA, key, signature, signed).catch(() => false),
  },
  // RFC 8463: the key is the raw 32 bytes, and what is signed is the SHA-256 of the headers.
  'ed25519-sha256': {
    keyType: 'ed25519',
    importKey: async key => {
      if (key.length !== 32) return 'key-invalid';
      const imported = await crypto.subtle
        .importKey('raw', key, { name: 'Ed25519' }, false, ['verify'])
        .catch(() => null);
      return imported ?? 'key-invalid';
    },
    verify: async (key, signature, signed) =>
      crypto.subtle
        .verify({ name: 'Ed25519' }, key, signature, await crypto.subtle.digest('SHA-256', signed))
        .catch(() => false),
  },
};

const isFws = (char: string | undefined) =>
  char === ' ' || char === '\t' || char === '\r' || char === '\n';

/** Without leading and trailing FWS. By hand: an end-anchored regex is quadratic on a long run. */
const trimFws = (text: string) => {
  let start = 0;
  let end = text.length;
  while (start < end && isFws(text[start])) start++;
  while (end > start && isFws(text[end - 1])) end--;
  return text.slice(start, end);
};

/** RFC 6376 §3.2: tag names are case-sensitive, and a repeated one makes the whole list invalid. */
const parseTagList = (text: string): ReadonlyMap<string, string> | null => {
  const tags = new Map<string, string>();
  for (const spec of text.split(';')) {
    if (spec.replace(WHITESPACE, '') === '') continue;
    const match = /^[ \t\r\n]*([A-Za-z][A-Za-z0-9_]*)[ \t\r\n]*=(.*)$/s.exec(spec);
    if (match === null) return null;
    const [, name = '', value = ''] = match;
    if (tags.has(name)) return null;
    tags.set(name, trimFws(value));
  }
  return tags;
};

/** A colon-separated list (`h=from:to`, a key's `s=email:*`), each item trimmed. */
const listOf = (value: string): string[] =>
  value.split(':').map(item => item.replace(WHITESPACE, ''));

/** Null for anything `fromBase64` refuses; folding whitespace inside the value is fine. */
const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> | null => {
  try {
    return Uint8Array.fromBase64(value.replace(WHITESPACE, ''));
  } catch {
    return null;
  }
};

const DOMAIN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

type Signature = {
  readonly field: HeaderField;
  readonly algorithm: Algorithm;
  readonly header: Canonicalization;
  readonly body: Canonicalization;
  readonly domain: string;
  readonly selector: string;
  /** Lowercased, in `h=` order. */
  readonly signedHeaders: readonly string[];
  readonly bodyHash: Uint8Array;
  readonly signature: Uint8Array<ArrayBuffer>;
  readonly bodyLength: number | null;
};

const isCanonicalization = (value: string): value is Canonicalization =>
  value === 'simple' || value === 'relaxed';

const parseSignature = (field: HeaderField): Signature | UnverifiedReason => {
  const tags = parseTagList(field.raw.slice(field.raw.indexOf(':') + 1));
  if (tags === null || tags.get('v') !== '1') return 'malformed';
  // A missing tag reads as empty, which every check below refuses.
  const tag = (name: string) => tags.get(name) ?? '';
  const algorithmName = tag('a');
  if (algorithmName === 'rsa-sha1') return 'weak-algorithm';
  const algorithm = Object.hasOwn(ALGORITHMS, algorithmName)
    ? ALGORITHMS[algorithmName]
    : undefined;
  if (algorithm === undefined) return 'unsupported';
  // `c=relaxed` alone is relaxed headers over a simple body.
  const [header = '', body = 'simple'] = (tags.get('c') ?? 'simple').split('/');
  if (!isCanonicalization(header) || !isCanonicalization(body)) return 'unsupported';
  const domain = tag('d').toLowerCase();
  const selector = tag('s').toLowerCase();
  if (!DOMAIN.test(domain) || !DOMAIN.test(selector)) return 'malformed';
  const bodyHash = decodeBase64(tag('bh'));
  const signature = decodeBase64(tag('b'));
  if (bodyHash === null || signature === null || signature.length === 0) return 'malformed';
  const length = tags.get('l');
  if (length !== undefined && !/^\d+$/.test(length)) return 'malformed';
  // ponytail: `i=`, `q=`, `t=` and `x=` are not read. None bears on who signed, and an expired
  // `x=` must not fail mail read long after delivery (docs/knowledge/dkim.md).
  const signedHeaders = listOf(tag('h')).map(name => name.toLowerCase());
  if (!signedHeaders.includes('from')) return 'from-not-signed';
  return {
    field,
    algorithm,
    header,
    body,
    domain,
    selector,
    signedHeaders,
    bodyHash,
    signature,
    bodyLength: length === undefined ? null : Number(length),
  };
};

/** The one mailbox of the one From field, or null for anything DMARC would not read as one author. */
const singleFrom = (headers: readonly HeaderField[]): string | null => {
  const froms = headers.filter(header => header.name === 'from');
  const [from] = froms;
  if (from === undefined || froms.length > 1) return null;
  const value = new TextDecoder().decode(bytesOf(from.raw.slice(from.raw.indexOf(':') + 1)));
  const parsed = addressParser(value.replaceAll('\r\n', ''));
  const [mailbox] = parsed;
  if (mailbox === undefined || parsed.length > 1 || mailbox.address === undefined) return null;
  const at = mailbox.address.lastIndexOf('@');
  if (at <= 0 || !DOMAIN.test(mailbox.address.slice(at + 1).toLowerCase())) return null;
  return mailbox.address;
};

/**
 * DMARC's relaxed alignment: the same organisational domain, read from the Public Suffix List
 * with its private section, so `a.github.io` and `b.github.io` are two organisations.
 */
const isAligned = (signingDomain: string, fromDomain: string) => {
  // Both are plain host names already; tldts must not cut a URL-ish one down to a host.
  const options = { allowPrivateDomains: true, extractHostname: false };
  const organisation = getDomain(fromDomain, options);
  return organisation !== null && organisation === getDomain(signingDomain, options);
};

/**
 * Fields a renderer or the IMAP server may read from the top, where anyone relaying a genuine
 * message can prepend an unsigned copy, mapped to how many instances may go unsigned. Subject and
 * Reply-To: none. The MIME fields: one, since Gmail signs neither, but never a second, since a
 * renderer may read the unsigned one.
 */
// ponytail: a lone unsigned Content-Type can be swapped outright, but only to reinterpret the
// sender's own signed bytes. Un-park if a reinterpretation that shows attacker content is seen.
const UNSIGNED_ALLOWED = new Map([
  ['subject', 0],
  ['reply-to', 0],
  ['content-type', 1],
  ['content-transfer-encoding', 1],
]);

type BodyDigest = { readonly length: number; readonly hash: Uint8Array };

const digestBody = async (
  body: Uint8Array,
  canonicalization: Canonicalization,
): Promise<BodyDigest> => {
  const canonical = canonicalBody(body, canonicalization);
  return {
    length: canonical.length,
    hash: new Uint8Array(await crypto.subtle.digest('SHA-256', canonical)),
  };
};

const isEqual = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

type Key = { readonly key: CryptoKey; readonly isStrict: boolean };

/** The signer's key from `<s>._domainkey.<d>`, held to the record's own rules for its use. */
const keyFor = async (
  signature: Signature,
  lookupTxt: TxtLookup,
): Promise<Key | UnverifiedReason> => {
  const records = await Promise.try(() =>
    lookupTxt(`${signature.selector}._domainkey.${signature.domain}`),
  ).catch(() => null);
  if (records === null) return 'key-unavailable';
  const tags = records
    .map(parseTagList)
    .find(
      (tags): tags is ReadonlyMap<string, string> =>
        tags !== null && tags.has('p') && (tags.get('v') ?? 'DKIM1') === 'DKIM1',
    );
  const publicKey = tags?.get('p');
  if (tags === undefined || publicKey === undefined) return 'key-unavailable';
  if ((tags.get('k') ?? 'rsa') !== signature.algorithm.keyType) return 'key-invalid';
  const hashes = tags.get('h');
  if (hashes !== undefined && !listOf(hashes).includes('sha256')) return 'key-invalid';
  const services = listOf(tags.get('s') ?? '*');
  if (!services.includes('*') && !services.includes('email')) return 'key-invalid';
  if (publicKey.replace(WHITESPACE, '') === '') return 'key-revoked';
  const keyBytes = decodeBase64(publicKey);
  if (keyBytes === null) return 'key-invalid';
  const key = await signature.algorithm.importKey(keyBytes);
  if (typeof key === 'string') return key;
  // `t=y` (testing) is ignored, as DMARC ignores it: the signature is still the domain's.
  return { key, isStrict: listOf(tags.get('t') ?? '').includes('s') };
};

/**
 * What the signature signs: each `h=` name picks that header's lowest instance not yet picked
 * (a name with none left adds nothing, which is what oversigning relies on), then the signature's
 * own field with its `b=` value emptied and no final CRLF.
 */
const signedBytes = (
  headers: readonly HeaderField[],
  signature: Signature,
): Uint8Array<ArrayBuffer> => {
  const unpicked = Map.groupBy(
    headers.filter(header => header !== signature.field),
    header => header.name,
  );
  const picked = signature.signedHeaders.flatMap(name => unpicked.get(name)?.splice(-1, 1) ?? []);
  const { raw } = signature.field;
  const colon = raw.indexOf(':') + 1;
  const unsigned = {
    ...signature.field,
    raw:
      raw.slice(0, colon) + raw.slice(colon).replace(/(^|;)([ \t\r\n]*b[ \t\r\n]*=)[^;]*/, '$1$2'),
  };
  const own = canonicalHeader(unsigned, signature.header).slice(0, -2);
  return bytesOf(picked.map(header => canonicalHeader(header, signature.header)).join('') + own);
};

const verifySignature = async (
  message: SplitMessage,
  field: HeaderField,
  from: string,
  lookupTxt: TxtLookup,
  bodyDigest: (canonicalization: Canonicalization) => Promise<BodyDigest>,
): Promise<DkimVerdict> => {
  const unverified = (reason: UnverifiedReason) => ({ status: 'unverified', reason }) as const;
  const signature = parseSignature(field);
  if (typeof signature === 'string') return unverified(signature);
  const fromDomain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
  // Before the network: an unaligned signature cannot vouch for this From however valid it is.
  if (!isAligned(signature.domain, fromDomain)) return unverified('not-aligned');
  const isAnyUnsigned = [...UNSIGNED_ALLOWED].some(
    ([name, allowed]) =>
      message.headers.filter(header => header.name === name).length >
      Math.max(allowed, signature.signedHeaders.filter(signed => signed === name).length),
  );
  if (isAnyUnsigned) return unverified('unsigned-header');
  const body = await bodyDigest(signature.body);
  // Shorter, and anything could follow it; longer, and the body hash fails anyway.
  if (signature.bodyLength !== null && signature.bodyLength !== body.length) {
    return unverified('partial-body');
  }
  if (!isEqual(body.hash, signature.bodyHash)) return unverified('body-changed');
  const key = await keyFor(signature, lookupTxt);
  if (typeof key === 'string') return unverified(key);
  // A `t=s` key vouches for its own domain only, not its subdomains.
  if (key.isStrict && fromDomain !== signature.domain) return unverified('not-aligned');
  const isValid = await signature.algorithm.verify(
    key.key,
    signature.signature,
    signedBytes(message.headers, signature),
  );
  return isValid
    ? { status: 'verified', from, domain: signature.domain }
    : unverified('bad-signature');
};

/**
 * Verified when one of the first `MAX_SIGNATURES` DKIM signatures, top first, is valid and aligned
 * with the single From. Total: malformed input is `unverified`, never a throw.
 */
export const verifySender = async (raw: Uint8Array, lookupTxt: TxtLookup): Promise<DkimVerdict> => {
  const message = splitMessage(raw);
  if (message === null) return { status: 'unverified', reason: 'malformed-headers' };
  const fields = message.headers.filter(header => header.name === 'dkim-signature');
  if (fields.length === 0) return { status: 'unverified', reason: 'no-signature' };
  const from = singleFrom(message.headers);
  if (from === null) return { status: 'unverified', reason: 'from-not-single' };
  const digests = new Map<Canonicalization, Promise<BodyDigest>>();
  const bodyDigest = (canonicalization: Canonicalization) => {
    const known = digests.get(canonicalization);
    if (known !== undefined) return known;
    const digest = digestBody(message.body, canonicalization);
    digests.set(canonicalization, digest);
    return digest;
  };
  const verdicts: DkimVerdict[] = [];
  for (const field of fields.slice(0, MAX_SIGNATURES)) {
    const verdict = await verifySignature(message, field, from, lookupTxt, bodyDigest);
    if (verdict.status === 'verified') return verdict;
    verdicts.push(verdict);
  }
  // The top signature's reason: usually the newest hop's, such as a mailing list's.
  return verdicts[0] ?? { status: 'unverified', reason: 'no-signature' };
};
