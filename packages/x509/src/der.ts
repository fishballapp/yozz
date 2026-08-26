/**
 * The DER TLV layer: bytes in, a tree of tag-length-value nodes out.
 *
 * This layer knows nothing about certificates. Recursion is decided by the
 * identifier octet's constructed bit ALONE, never by a schema — so a BIT STRING
 * holding an SPKI, or an OCTET STRING holding an extension value, stops here and
 * M3 re-enters it deliberately with `decodeDer(node.content)`. That is not a
 * limitation: from the outside you cannot tell DER from a JPEG, and a decoder
 * that guesses is a decoder an attacker steers.
 *
 * Two properties are structural rather than checked, which is the point:
 *
 *  - **Nodes hold `subarray` VIEWS, never copies.** M3's requirement to retain
 *    `tbsCertificate` verbatim falls out for free, and the reject-list's "refuse
 *    a declared length before allocating" becomes impossible to get wrong —
 *    nothing is ever allocated on a declared length, it is only compared against
 *    the bytes remaining.
 *  - **Failure throws `DerError` and nothing else.** M4 catches it once and maps
 *    it to `malformed-certificate`, so `tls` never grows a second failure path.
 *    The fuzz gate asserts every throw is one of these: a `TypeError`, a
 *    `RangeError` from stack exhaustion, or an OOM is a FAILURE, not an outcome.
 *
 * The trap this replaces, from the encoder this package is seeded from
 * (`@fishballpkg/acme`): `Uint8Array.prototype.slice` CLAMPS. A TLV declaring
 * 900 bytes with 9 present yields a 9-byte value and no error at all. Every
 * length-driven read here compares against the enclosing bound first.
 *
 * NOT here, deliberately: `decodeNull`, and the string types decoded to JS
 * strings. Both need policy this layer has no business holding — M3 owns
 * `AlgorithmIdentifier`'s absent-vs-NULL parameters, and charset handling
 * (embedded nulls, UTF-8 validity) belongs with name comparison at M4.
 */

/**
 * Certificates nest about ten deep; `otherName` inside a GeneralName is the
 * deepest real shape. 32 is generous, and low enough that this check fires long
 * before V8's own stack does — a RangeError is not our failure type.
 */
const MAXIMUM_DEPTH = 32;

/**
 * Four octets is 4GiB, which no input approaches, and it keeps every length sum
 * inside a safe integer. Leading zeros are rejected separately, so a fifth octet
 * can only ever mean a length no buffer could satisfy.
 */
const MAXIMUM_LENGTH_OCTETS = 4;

/**
 * Same bound on the base-128 digits of a high-form tag number. Nothing in X.509
 * exceeds 30, so this only stops an unbounded run of continuation octets from
 * inflating `tagNumber` to `Infinity` and letting a nonsense value reach M3.
 */
const MAXIMUM_TAG_OCTETS = 4;

/**
 * Total nodes one input may produce. Depth is bounded separately and does not
 * bound this: a SHALLOW constructed value holding a million two-byte empty TLVs
 * allocates a million node objects before any schema can reject the first
 * unexpected field, and a TLS certificate message is large enough to carry it.
 *
 * Real certificates run to a few thousand nodes, so this is far above use and
 * still refuses the amplification.
 */
const MAXIMUM_NODES = 50_000;

/**
 * Octets in ONE base-128 OID subidentifier. Arcs are accumulated into a bigint
 * that grows with every continuation octet, so an unbounded arc buys superlinear
 * work from a single attacker-supplied OID. No real arc exceeds five octets.
 */
const MAXIMUM_SUBIDENTIFIER_OCTETS = 16;

/**
 * The universal types a certificate can contain, each with the form DER REQUIRES
 * of it (X.690 s10.2). One table rather than two: the tag number and the rule
 * about it belong in the same row.
 *
 * A universal tag absent from this table is rejected. That is a deliberate
 * fail-closed call — the X.509 type universe is fixed, and the smallest
 * accepting surface for attacker-chosen bytes is the right one.
 *
 * TELETEX_STRING, UNIVERSAL_STRING and BMP_STRING are UNTESTED BY EITHER CORPUS:
 * 706 sampled x509-limbo certificates and all 59 harvested ones use only
 * PrintableString, UTF8String, IA5String, UTCTime and GeneralizedTime. They stay
 * because they are legal `DirectoryString` choices (RFC 5280 s4.1.2.4) and
 * rejecting a legal encoding is a bug, not a fail-closed posture.
 */
const UNIVERSAL_TYPES = {
  BOOLEAN: { tag: 1, form: 'primitive' },
  INTEGER: { tag: 2, form: 'primitive' },
  BIT_STRING: { tag: 3, form: 'primitive' },
  OCTET_STRING: { tag: 4, form: 'primitive' },
  NULL: { tag: 5, form: 'primitive' },
  OID: { tag: 6, form: 'primitive' },
  UTF8_STRING: { tag: 12, form: 'primitive' },
  SEQUENCE: { tag: 16, form: 'constructed' },
  SET: { tag: 17, form: 'constructed' },
  PRINTABLE_STRING: { tag: 19, form: 'primitive' },
  TELETEX_STRING: { tag: 20, form: 'primitive' },
  IA5_STRING: { tag: 22, form: 'primitive' },
  UTC_TIME: { tag: 23, form: 'primitive' },
  GENERALIZED_TIME: { tag: 24, form: 'primitive' },
  UNIVERSAL_STRING: { tag: 28, form: 'primitive' },
  BMP_STRING: { tag: 30, form: 'primitive' },
} as const satisfies Record<string, { tag: number; form: 'primitive' | 'constructed' }>;

/** The same table, keyed the way the decoder meets it: by number, off the wire. */
const REQUIRED_FORM_BY_UNIVERSAL_TAG = new Map<number, 'primitive' | 'constructed'>(
  Object.values(UNIVERSAL_TYPES).map(({ tag, form }) => [tag, form]),
);

/**
 * Which rule the bytes broke. Tests assert THIS, never just that something threw
 * — otherwise a vector for "non-minimal length" passes because of an unrelated
 * bounds failure, and the reject-list proves nothing.
 */
export type DerFailureCode =
  /** A header or a declared length runs past its enclosing bound — the input, or a parent's content. */
  | 'truncated'
  /** Length octet `0x80`. BER's indefinite form, which DER forbids outright. */
  | 'indefinite-length'
  /** Length octet `0xFF`, reserved by X.690 s8.1.3.5(c). */
  | 'reserved-length'
  /** Long form for a length under 128, or long form carrying a leading zero octet. */
  | 'non-minimal-length'
  /** More length octets than a safe integer holds. */
  | 'length-too-large'
  /** High-tag-number form for a tag under 31, or a leading `0x80` in its base-128 digits. */
  | 'non-minimal-tag'
  /** More base-128 tag octets than any real tag needs. */
  | 'tag-too-large'
  /** Constructed where DER demands primitive (a segmented OCTET STRING), or the reverse. */
  | 'wrong-form'
  /** A universal tag number outside the X.509 type universe. */
  | 'unsupported-universal-tag'
  /** Nesting past `MAXIMUM_DEPTH`. Bounded here so V8's stack never decides it. */
  | 'depth-exceeded'
  /** Bytes after the one top-level TLV. A certificate is exactly one. */
  | 'trailing-data'
  /** A value decoder was handed a node of the wrong type. */
  | 'unexpected-tag'
  /** The TLVs are well-formed and do not spell the structure they should. */
  | 'malformed-structure'
  /** The tag is right and the content breaks the type's own DER rules. */
  | 'malformed-value';

/**
 * The only thing this module throws. `instanceof` is what the M2 fuzz gate
 * asserts, so anything else escaping is the bug the gate exists to find.
 */
export class DerError extends Error {
  readonly code: DerFailureCode;
  /** Offset into the input the node was decoded from. */
  readonly offset: number;

  constructor(code: DerFailureCode, offset: number, detail: string) {
    super(`${code} at offset ${offset}: ${detail}`);
    this.name = 'DerError';
    this.code = code;
    this.offset = offset;
  }
}

export type TagClass = 'universal' | 'application' | 'context' | 'private';

type DerNodeBase = {
  readonly tagClass: TagClass;
  readonly tagNumber: number;
  /** Offset of the identifier octet, relative to the input `decodeDer` was given. */
  readonly offset: number;
  /** Identifier + length + content, verbatim. A view. This is what M3 hashes over. */
  readonly bytes: Uint8Array;
  /** Content only. A view. */
  readonly content: Uint8Array;
};

/**
 * A union rather than a nullable `children`, so a primitive node has no field to
 * assert past — the repo bans `!`, and this shape means nobody needs one.
 */
export type DerNode =
  | (DerNodeBase & { readonly isConstructed: false })
  | (DerNodeBase & { readonly isConstructed: true; readonly children: readonly DerNode[] });

/**
 * Reads one octet, or throws. `end` is the enclosing bound — the input's length
 * at the top level, a parent's content end inside one — which is what makes
 * "a child overshoots its parent" and "the input is short" the same rule.
 */
const byteAt = (input: Uint8Array, index: number, end: number, expected: string): number => {
  const byte = index < end ? input[index] : undefined;
  if (byte === undefined) throw new DerError('truncated', index, `expected ${expected}`);
  return byte;
};

/** Two bits, four classes, no index that can miss. */
const tagClassOf = (identifier: number): TagClass => {
  switch (identifier >> 6) {
    case 0:
      return 'universal';
    case 1:
      return 'application';
    case 2:
      return 'context';
    default:
      return 'private';
  }
};

const HIGH_TAG_NUMBER_FORM = 0x1f;
const CONSTRUCTED_BIT = 0x20;
const CONTINUES = 0x80;

const decodeIdentifier = (
  input: Uint8Array,
  offset: number,
  end: number,
): { tagClass: TagClass; tagNumber: number; isConstructed: boolean; nextOffset: number } => {
  const identifier = byteAt(input, offset, end, 'an identifier octet');
  const tagClass = tagClassOf(identifier);
  const isConstructed = (identifier & CONSTRUCTED_BIT) !== 0;
  const low = identifier & HIGH_TAG_NUMBER_FORM;
  if (low !== HIGH_TAG_NUMBER_FORM) {
    return { tagClass, tagNumber: low, isConstructed, nextOffset: offset + 1 };
  }

  // Base-128, most significant digit first, high bit set on every octet but the last.
  let tagNumber = 0;
  let index = offset + 1;
  for (;;) {
    const digit = byteAt(input, index, end, 'a tag-number octet');
    if (index === offset + 1 && digit === CONTINUES) {
      throw new DerError('non-minimal-tag', offset, 'a leading 0x80 pads the base-128 tag number');
    }
    if (index - offset > MAXIMUM_TAG_OCTETS) {
      throw new DerError('tag-too-large', offset, `over ${MAXIMUM_TAG_OCTETS} base-128 tag octets`);
    }
    tagNumber = tagNumber * 128 + (digit & ~CONTINUES);
    index += 1;
    if ((digit & CONTINUES) === 0) break;
  }
  if (tagNumber < HIGH_TAG_NUMBER_FORM) {
    throw new DerError('non-minimal-tag', offset, `tag ${tagNumber} fits the short form`);
  }
  return { tagClass, tagNumber, isConstructed, nextOffset: index };
};

const decodeLength = (
  input: Uint8Array,
  offset: number,
  end: number,
): { length: number; nextOffset: number } => {
  const first = byteAt(input, offset, end, 'a length octet');
  // Both of these are checked before anything is read, so a two-byte `30 FF`
  // reports the reserved octet rather than the missing content.
  if (first === 0x80) throw new DerError('indefinite-length', offset, "BER's indefinite form");
  if (first === 0xff) throw new DerError('reserved-length', offset, 'X.690 s8.1.3.5(c)');
  if (first < 0x80) return { length: first, nextOffset: offset + 1 };

  const octetCount = first & ~CONTINUES;
  if (octetCount > MAXIMUM_LENGTH_OCTETS) {
    throw new DerError('length-too-large', offset, `${octetCount} length octets`);
  }
  const octets = Array.from({ length: octetCount }, (_, index) =>
    byteAt(input, offset + 1 + index, end, 'a long-form length octet'),
  );
  if (octets[0] === 0) {
    throw new DerError('non-minimal-length', offset, 'a leading zero octet');
  }
  const length = octets.reduce((total, octet) => total * 256 + octet, 0);
  if (length < 0x80) {
    throw new DerError('non-minimal-length', offset, `${length} fits the short form`);
  }
  return { length, nextOffset: offset + 1 + octetCount };
};

const decodeNode = (
  input: Uint8Array,
  offset: number,
  end: number,
  depth: number,
  budget: { remaining: number },
): DerNode => {
  if (depth > MAXIMUM_DEPTH) {
    throw new DerError('depth-exceeded', offset, `nesting deeper than ${MAXIMUM_DEPTH}`);
  }
  budget.remaining -= 1;
  if (budget.remaining < 0) {
    throw new DerError('depth-exceeded', offset, `over ${MAXIMUM_NODES} nodes in one input`);
  }

  const { tagClass, tagNumber, isConstructed, nextOffset } = decodeIdentifier(input, offset, end);
  const { length, nextOffset: contentStart } = decodeLength(input, nextOffset, end);
  const contentEnd = contentStart + length;
  if (contentEnd > end) {
    throw new DerError(
      'truncated',
      offset,
      `declares ${length} content bytes, ${end - contentStart} remain`,
    );
  }

  if (tagClass === 'universal') {
    const requiredForm = REQUIRED_FORM_BY_UNIVERSAL_TAG.get(tagNumber);
    if (requiredForm === undefined) {
      throw new DerError('unsupported-universal-tag', offset, `universal tag ${tagNumber}`);
    }
    if ((requiredForm === 'constructed') !== isConstructed) {
      throw new DerError(
        'wrong-form',
        offset,
        `universal tag ${tagNumber} must be ${requiredForm}`,
      );
    }
  }

  const base = {
    tagClass,
    tagNumber,
    offset,
    bytes: input.subarray(offset, contentEnd),
    content: input.subarray(contentStart, contentEnd),
  };
  if (!isConstructed) return { ...base, isConstructed: false };

  // A cursor is the honest shape here: the child count is not known up front,
  // it falls out of how many bytes each child consumes. Every TLV is at least
  // two octets, so this always advances.
  const children: DerNode[] = [];
  let childOffset = contentStart;
  while (childOffset < contentEnd) {
    const child = decodeNode(input, childOffset, contentEnd, depth + 1, budget);
    children.push(child);
    childOffset += child.bytes.length;
  }
  return { ...base, isConstructed: true, children };
};

/**
 * Decodes exactly ONE TLV and rejects anything after it. A certificate is one
 * SEQUENCE; an extension's `extnValue` is one TLV inside an OCTET STRING. Both
 * want the trailing-data check, so re-entry is just `decodeDer(node.content)`.
 */
export const decodeDer = (input: Uint8Array): DerNode => {
  const node = decodeNode(input, 0, input.length, 0, { remaining: MAXIMUM_NODES });
  if (node.bytes.length !== input.length) {
    throw new DerError(
      'trailing-data',
      node.bytes.length,
      `${input.length - node.bytes.length} bytes follow the top-level TLV`,
    );
  }
  return node;
};

/** The tag check every value decoder owes, with `UNIVERSAL_TYPES` as the one source of truth. */
const contentOf = (node: DerNode, type: keyof typeof UNIVERSAL_TYPES): Uint8Array => {
  if (node.tagClass !== 'universal' || node.tagNumber !== UNIVERSAL_TYPES[type].tag) {
    throw new DerError(
      'unexpected-tag',
      node.offset,
      `expected ${type}, got ${node.tagClass} ${node.tagNumber}`,
    );
  }
  return node.content;
};

/** DER admits exactly two encodings: `0x00` and `0xFF`. `0x01` is BER's truthy. */
export const decodeBoolean = (node: DerNode): boolean => {
  const content = contentOf(node, 'BOOLEAN');
  const [octet] = content;
  if (content.length !== 1 || octet === undefined) {
    throw new DerError(
      'malformed-value',
      node.offset,
      `a BOOLEAN is one octet, got ${content.length}`,
    );
  }
  if (octet === 0x00) return false;
  if (octet === 0xff) return true;
  throw new DerError(
    'malformed-value',
    node.offset,
    `DER's true is 0xFF, got 0x${octet.toString(16)}`,
  );
};

/** Two's complement, minimally encoded. `bigint` because serial numbers are 20 octets. */
export const decodeInteger = (node: DerNode): bigint => {
  const content = contentOf(node, 'INTEGER');
  const [first, second] = content;
  if (first === undefined) {
    throw new DerError('malformed-value', node.offset, 'an INTEGER has no empty encoding');
  }
  // X.690 s8.3.2: the leading nine bits may be neither all zero nor all one.
  const isRedundantZeroPad = first === 0x00 && second !== undefined && second < 0x80;
  const isRedundantSignPad = first === 0xff && second !== undefined && second >= 0x80;
  if (isRedundantZeroPad || isRedundantSignPad) {
    throw new DerError(
      'malformed-value',
      node.offset,
      'non-minimal: the leading octet is redundant',
    );
  }
  const magnitude = content.reduce((total, octet) => (total << 8n) | BigInt(octet), 0n);
  return first < 0x80 ? magnitude : magnitude - (1n << BigInt(8 * content.length));
};

/**
 * Dotted-decimal. The first octet packs two arcs as `40 * arc1 + arc2`, but arc1
 * is only ever 0, 1 or 2 — so `Math.floor(byte / 40)` is WRONG above 119 and
 * yields a nonexistent arc 3. subtls has this bug (m0 notes, `asn1bytes.ts:32`).
 *
 * Arcs after the first are base-128, most significant digit first, with the high
 * bit set on every octet but the last. DER wants them minimal and terminated.
 */
export const decodeOid = (node: DerNode): string => {
  const content = contentOf(node, 'OID');
  const malformed = (detail: string): DerError =>
    new DerError('malformed-value', node.offset, detail);
  if (content.length === 0) throw malformed('an OID has at least one subidentifier');

  // bigint, not number: ten continuation octets encode a 70-bit arc, which a
  // double starts silently rounding. No real OID comes close, and a subidentifier
  // an attacker rounded into a DIFFERENT OID is the whole class of bug worth
  // spending a few bigint ops to make impossible.
  const subidentifiers: bigint[] = [];
  let value = 0n;
  let isStartOfSubidentifier = true;
  let octetsInSubidentifier = 0;
  for (const octet of content) {
    if (isStartOfSubidentifier && octet === CONTINUES) {
      throw malformed('a leading 0x80 pads a base-128 subidentifier');
    }
    octetsInSubidentifier += 1;
    if (octetsInSubidentifier > MAXIMUM_SUBIDENTIFIER_OCTETS) {
      throw malformed(`a subidentifier over ${MAXIMUM_SUBIDENTIFIER_OCTETS} octets`);
    }
    value = (value << 7n) | BigInt(octet & ~CONTINUES);
    const isLastOctet = (octet & CONTINUES) === 0;
    if (isLastOctet) {
      subidentifiers.push(value);
      value = 0n;
      octetsInSubidentifier = 0;
    }
    isStartOfSubidentifier = isLastOctet;
  }
  if (!isStartOfSubidentifier) throw malformed('the final subidentifier never terminates');

  const [first, ...rest] = subidentifiers;
  if (first === undefined) throw malformed('an OID has at least one subidentifier');
  // Arc 1 is 0, 1 or 2 and nothing else, so above 119 the SECOND arc simply keeps
  // growing. `first / 40n` would report arc 3 here, which does not exist.
  const firstArc = first < 40n ? 0n : first < 80n ? 1n : 2n;
  return [firstArc, first - firstArc * 40n, ...rest].join('.');
};

/** DER requires the unused trailing bits to be zero, not merely declared. */
export const decodeBitString = (
  node: DerNode,
): { readonly bytes: Uint8Array; readonly unusedBits: number } => {
  const content = contentOf(node, 'BIT_STRING');
  const [unusedBits] = content;
  if (unusedBits === undefined) {
    throw new DerError('malformed-value', node.offset, 'a BIT STRING carries an unused-bits octet');
  }
  if (unusedBits > 7) {
    throw new DerError('malformed-value', node.offset, `${unusedBits} unused bits, at most 7`);
  }
  const bytes = content.subarray(1);
  if (unusedBits > 0 && bytes.length === 0) {
    throw new DerError('malformed-value', node.offset, 'unused bits declared over no content');
  }
  const last = bytes.at(-1);
  if (last !== undefined && (last & ((1 << unusedBits) - 1)) !== 0) {
    throw new DerError('malformed-value', node.offset, 'the unused trailing bits are not zero');
  }
  return { bytes, unusedBits };
};

/** Both RFC 5280 time types are fixed-width, seconds-mandatory and Z-only. */
const UTC_TIME_SHAPE = /^\d{12}Z$/;
const GENERALIZED_TIME_SHAPE = /^\d{14}Z$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

/**
 * UTCTime or GeneralizedTime. Calendar fields are range-checked BEFORE a `Date`
 * is built, because `new Date('2024-02-30T00:00:00Z')` silently returns March
 * 1st — measured, not assumed. Left to the Date constructor, a malformed
 * `notAfter` buys a day of validity and disagrees with OpenSSL, which is a
 * verdict flip under x509-limbo.
 *
 * `Date`, not `Temporal.Instant`, to match the frozen `validationTime` in the
 * validator contract — this and that meet in one comparison at M4.
 */
export const decodeTime = (node: DerNode): Date => {
  const isUtcTime = node.tagNumber === UNIVERSAL_TYPES.UTC_TIME.tag;
  if (
    node.tagClass !== 'universal' ||
    (!isUtcTime && node.tagNumber !== UNIVERSAL_TYPES.GENERALIZED_TIME.tag)
  ) {
    throw new DerError('unexpected-tag', node.offset, 'expected UTC_TIME or GENERALIZED_TIME');
  }

  const text = new TextDecoder().decode(node.content);
  if (!(isUtcTime ? UTC_TIME_SHAPE : GENERALIZED_TIME_SHAPE).test(text)) {
    throw new DerError(
      'malformed-value',
      node.offset,
      `not RFC 5280 ${isUtcTime ? 'UTCTime' : 'GeneralizedTime'}: ${JSON.stringify(text)}`,
    );
  }

  // The shape is now proven fixed-width, so slicing by offset cannot miss.
  const digitsAt = (start: number): number => Number(text.slice(start, start + 2));
  const twoDigitYear = digitsAt(0);
  // RFC 5280 s4.1.2.5.1 pivots at 50: 49 is 2049, 50 is 1950.
  const year = isUtcTime
    ? (twoDigitYear < 50 ? 2000 : 1900) + twoDigitYear
    : Number(text.slice(0, 4));
  const rest = isUtcTime ? 2 : 4;
  const month = digitsAt(rest);
  const day = digitsAt(rest + 2);
  const hour = digitsAt(rest + 4);
  const minute = digitsAt(rest + 6);
  const second = digitsAt(rest + 8);

  const malformed = (detail: string): DerError =>
    new DerError('malformed-value', node.offset, `${detail} in ${JSON.stringify(text)}`);
  if (month < 1 || month > 12) throw malformed(`month ${month}`);
  if (day < 1 || day > daysInMonth(year, month)) throw malformed(`day ${day} of month ${month}`);
  // 60 is a leap second, which RFC 5280 does not admit.
  if (hour > 23 || minute > 59 || second > 59) throw malformed('time of day');

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
};
