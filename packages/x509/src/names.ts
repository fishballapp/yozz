import type {
  AttributeTypeAndValue,
  GeneralName,
  GeneralSubtree,
  Name,
  NameConstraints,
} from './certificate.ts';
import { decodeDer } from './der.ts';
import type { PeerName } from './validator.ts';

/** For hostnames, which are LDH by definition. Directory strings use `prepareForComparison`. */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0x20));

/** Refused rather than normalised: an embedded NUL, a trailing dot, an empty label, a non-LDH byte. */
const isComparableHostname = (host: string): boolean => {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  return labels.every(
    label =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/.test(asciiLower(label)) &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
};

/** RFC 6125 as WebPKI narrows it: a wildcard is the whole leftmost label, matches one label, never an A-label, and needs two labels to its right. */
export const matchesDnsName = (presented: string, host: string): boolean => {
  const name = asciiLower(presented);
  const target = asciiLower(host);
  if (!isComparableHostname(target)) return false;
  if (!name.startsWith('*.')) return isComparableHostname(name) && name === target;

  const suffix = name.slice(2);
  if (!isComparableHostname(suffix) || suffix.split('.').length < 2) return false;
  if (suffix.startsWith('xn--')) return false;
  const [firstLabel, ...rest] = target.split('.');
  return firstLabel !== undefined && !firstLabel.startsWith('xn--') && rest.join('.') === suffix;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_WORD = /^[0-9a-fA-F]{1,4}$/;

/** Dotted-quad, or IPv6 including the IPv4-tail form. Every form is exact or refused. */
export const parseIpAddress = (text: string): Uint8Array | null => {
  const quad = IPV4.exec(text);
  if (quad !== null) {
    // `010` is not `10` in an address literal.
    if (/(^|\.)0\d/.test(text)) return null;
    const parts = quad.slice(1).map(Number);
    return parts.every(part => part <= 255) ? Uint8Array.from(parts) : null;
  }
  if (!text.includes(':')) return null;

  const sections = text.split('::');
  if (sections.length > 2) return null;
  const [head = '', tail] = sections;

  const toWords = (section: string): number[] | null => {
    if (section === '') return [];
    const parts = section.split(':');
    const last = parts.at(-1) ?? '';
    if (!last.includes('.')) {
      return parts.every(part => HEX_WORD.test(part))
        ? parts.map(part => Number.parseInt(part, 16))
        : null;
    }
    const embedded = parseIpAddress(last);
    const hexParts = parts.slice(0, -1);
    if (embedded === null || embedded.length !== 4) return null;
    if (!hexParts.every(part => HEX_WORD.test(part))) return null;
    return [
      ...hexParts.map(part => Number.parseInt(part, 16)),
      ((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0),
      ((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0),
    ];
  };

  const left = toWords(head);
  const right = tail === undefined ? [] : toWords(tail);
  if (left === null || right === null) return null;
  const total = left.length + right.length;
  // `::` stands for at least one word.
  if (tail === undefined ? total !== 8 : total >= 8) return null;
  const words = [...left, ...Array.from({ length: 8 - total }, () => 0), ...right];
  return Uint8Array.from(words.flatMap(word => [word >> 8, word & 0xff]));
};

const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** CN is never consulted, as in every browser. */
export const matchesPeerName = (
  subjectAltNames: readonly GeneralName[],
  expected: PeerName,
): boolean => {
  if (expected.kind === 'ip') {
    const address = parseIpAddress(expected.value);
    if (address === null) return false;
    return subjectAltNames.some(name => name.kind === 'ip' && isSameBytes(name.bytes, address));
  }
  return subjectAltNames.some(
    name => name.kind === 'dns' && matchesDnsName(name.value, expected.value),
  );
};

/** `null`: the pair cannot be evaluated, which `violatesConstraints` treats as a refusal in both directions. */
type SubtreeVerdict = boolean | null;

/** `example.com` covers `example.com` and `a.example.com`, never `notexample.com`; an empty constraint covers everything. */
const dnsWithinSubtree = (name: string, constraint: string): SubtreeVerdict => {
  const target = asciiLower(name);
  const base = asciiLower(constraint);
  if (base === '') return true;
  // RFC 5280 §4.2.1.10 gives dNSName no leading-dot form.
  if (base.startsWith('.')) return null;
  if (!isComparableHostname(target)) return false;
  return target === base || target.endsWith(`.${base}`);
};

/**
 * Permitted asks whether everything a wildcard can authenticate is inside the subtree; excluded asks
 * whether it can authenticate anything inside it. Stripping the wildcard for both is CVE-2025-61727.
 */
const dnsMatchesSubtree = (
  name: string,
  constraint: string,
  isExclusion: boolean,
): SubtreeVerdict => {
  if (!name.startsWith('*.')) return dnsWithinSubtree(name, constraint);
  const base = name.slice(2);
  if (!isExclusion) return dnsWithinSubtree(base, constraint);
  const covers = dnsWithinSubtree(base, constraint);
  const reaches = dnsWithinSubtree(constraint, base);
  if (covers === null || reaches === null) return null;
  return covers || reaches;
};

const hostOfUri = (uri: string): string | null => {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(uri);
  const authority = match?.[1];
  if (authority === undefined) return null;
  const afterUserInfo = authority.split('@').at(-1) ?? '';
  // A bracketed IPv6 literal keeps its own colons.
  const bracketed = /^\[(.+)\]/.exec(afterUserInfo);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const host = afterUserInfo.split(':')[0];
  return host === undefined || host === '' ? null : host;
};

/** RFC 5280 §4.2.1.10: without a leading period the constraint names one exact host; with one, proper subdomains only. */
const uriWithinSubtree = (uri: string, constraint: string): SubtreeVerdict => {
  const host = hostOfUri(uri);
  if (host === null) return null;
  if (parseIpAddress(host) !== null) return null;
  const target = asciiLower(host);
  if (!isComparableHostname(target)) return null;
  const base = asciiLower(constraint);
  if (base === '') return null;
  return base.startsWith('.') ? target.endsWith(base) : target === base;
};

const emailWithinSubtree = (mailbox: string, constraint: string): SubtreeVerdict => {
  const host = mailbox.split('@').at(-1);
  if (host === undefined || host === '') return null;
  if (constraint.includes('@')) {
    const [constraintLocal, constraintHost = ''] = constraint.split('@');
    const [local] = mailbox.split('@');
    return local === constraintLocal && asciiLower(host) === asciiLower(constraintHost);
  }
  if (constraint === '') return null;
  return constraint.startsWith('.')
    ? asciiLower(host).endsWith(asciiLower(constraint))
    : asciiLower(host) === asciiLower(constraint);
};

/** Address followed by mask: 8 octets for v4, 32 for v6. */
const ipWithinSubtree = (address: Uint8Array, constraint: Uint8Array): SubtreeVerdict => {
  if (constraint.length !== address.length * 2) {
    // The other family is a non-match; neither family cannot be applied.
    return constraint.length === 8 || constraint.length === 32 ? false : null;
  }
  return address.every((byte, index) => {
    const base = constraint[index] ?? 0;
    const mask = constraint[address.length + index] ?? 0;
    return (byte & mask) === (base & mask);
  });
};

/** A type absent here yields an unprocessable comparison rather than an invented key. */
const STRING_ENCODINGS: Readonly<Record<number, string>> = {
  12: 'utf-8',
  19: 'ascii',
  20: 'ascii',
  22: 'ascii',
  30: 'utf-16be',
};

/** RFC 4518. `toLowerCase` is locale-independent (`toLocaleLowerCase` is the one that maps Turkish dotted I). */
const prepareForComparison = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Fatal decoding: a lenient decoder maps every invalid sequence to U+FFFD, collapsing distinct values. */
const canonicalAttribute = ({ oid, valueDer }: AttributeTypeAndValue): string | null => {
  try {
    const value = decodeDer(valueDer);
    const encoding = STRING_ENCODINGS[value.tagNumber];
    if (encoding === undefined) return null;
    return `${oid}=${prepareForComparison(new TextDecoder(encoding, { fatal: true }).decode(value.content))}`;
  } catch {
    return null;
  }
};

/** An RDN is a SET, so its attributes have no order. */
const isSameRelativeDistinguishedName = (
  a: readonly AttributeTypeAndValue[],
  b: readonly AttributeTypeAndValue[],
): SubtreeVerdict => {
  if (a.length !== b.length) return false;
  const isPrepared = (value: string | null): value is string => value !== null;
  const left = a.map(canonicalAttribute).filter(isPrepared);
  const right = b.map(canonicalAttribute).filter(isPrepared);
  if (left.length !== a.length || right.length !== b.length) return null;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

/** Satisfied when the constraint's RDNs are a prefix of the subject's. */
const directoryWithinSubtree = (subject: Name, constraint: Name): SubtreeVerdict => {
  const base = constraint.relativeDistinguishedNames;
  const target = subject.relativeDistinguishedNames;
  if (base.length > target.length) return false;
  for (const [index, rdn] of base.entries()) {
    const candidate = target[index];
    if (candidate === undefined) return false;
    const isSame = isSameRelativeDistinguishedName(rdn, candidate);
    if (isSame !== true) return isSame;
  }
  return true;
};

const withinSubtree = (
  name: GeneralName,
  base: GeneralName,
  isExclusion: boolean,
): SubtreeVerdict => {
  if (name.kind !== base.kind) return false;
  if (name.kind === 'dns' && base.kind === 'dns') {
    return dnsMatchesSubtree(name.value, base.value, isExclusion);
  }
  if (name.kind === 'ip' && base.kind === 'ip') return ipWithinSubtree(name.bytes, base.bytes);
  if (name.kind === 'rfc822' && base.kind === 'rfc822') {
    return emailWithinSubtree(name.value, base.value);
  }
  if (name.kind === 'directory' && base.kind === 'directory') {
    return directoryWithinSubtree(name.name, base.name);
  }
  if (name.kind === 'uri' && base.kind === 'uri') return uriWithinSubtree(name.value, base.value);
  return null;
};

export type ConstraintState = {
  /** One entry per certificate that stated permittedSubtrees; flattening them would turn intersection into union. */
  readonly permittedLevels: readonly (readonly GeneralSubtree[])[];
  readonly excluded: readonly GeneralSubtree[];
};

export const EMPTY_CONSTRAINTS: ConstraintState = { permittedLevels: [], excluded: [] };

/** RFC 5280 §6.1.4(g): permitted subtrees intersect down the chain, excluded subtrees union. */
export const addConstraints = (
  state: ConstraintState,
  constraints: NameConstraints | null,
): ConstraintState =>
  constraints === null
    ? state
    : {
        permittedLevels:
          constraints.permitted.length === 0
            ? state.permittedLevels
            : [...state.permittedLevels, constraints.permitted],
        excluded: [...state.excluded, ...constraints.excluded],
      };

/** A security control, not a performance one: `pathological::nc-dos-1` is 8.4 million comparisons and limbo expects it refused. */
const MAXIMUM_NAME_COMPARISONS = 250_000;

/**
 * RFC 5280 §6.1.3(b)(c). A level that states no subtree of a name's form does not constrain it.
 * Exhausting the comparison budget is a refusal.
 */
export const violatesConstraints = (
  names: readonly GeneralName[],
  state: ConstraintState,
): boolean => {
  let budget = MAXIMUM_NAME_COMPARISONS;
  // Grouped once: re-filtering per name is itself the denial of service.
  const permittedByKind = state.permittedLevels.map(level =>
    Map.groupBy(level, ({ base }) => base.kind),
  );

  for (const name of names) {
    for (const { base } of state.excluded) {
      if (budget <= 0) return true;
      budget -= 1;
      if (withinSubtree(name, base, true) !== false) return true;
    }

    for (const byKind of permittedByKind) {
      const applicable = byKind.get(name.kind);
      if (applicable === undefined) continue;
      const isCovered = ((): boolean => {
        for (const { base } of applicable) {
          if (budget <= 0) return false;
          budget -= 1;
          if (withinSubtree(name, base, false) === true) return true;
        }
        return false;
      })();
      if (!isCovered) return true;
    }
  }
  return false;
};
