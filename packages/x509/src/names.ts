/**
 * Name matching and name constraints.
 *
 * This file decides most of the score: 9491 of x509-limbo's 9786 cases are
 * `bettertls::nameconstraints`. It is also where a certificate stops being a
 * data structure and starts being an authorisation, so every comparison here is
 * written to fail closed on anything it does not understand.
 */
import type {
  AttributeTypeAndValue,
  GeneralName,
  GeneralSubtree,
  Name,
  NameConstraints,
} from './certificate.ts';
import { decodeDer } from './der.ts';
import type { PeerName } from './validator.ts';

/**
 * ASCII-only lowercase, for hostnames. A hostname is LDH by definition, so
 * folding only A-Z is exact here and says so. Directory-string values are a
 * different problem and use `prepareForComparison` instead.
 */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]/g, letter => String.fromCharCode(letter.charCodeAt(0) + 0x20));

/**
 * A hostname we are willing to compare at all. Anything else — an embedded NUL,
 * a trailing dot, an empty label, a non-LDH byte — is refused rather than
 * normalised, because every normalisation is a chance to agree with an attacker
 * about what a name means.
 */
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

/**
 * RFC 6125 as WebPKI narrows it: a wildcard is the WHOLE leftmost label, never a
 * prefix like `www*`, it matches exactly one label, and it never applies to an
 * A-label. Two labels minimum on the right, so `*.com` matches nothing.
 */
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

/**
 * Dotted-quad, or IPv6 including the IPv4-tail form.
 *
 * Laxity is the dangerous direction here: this parses the name a caller ASKED
 * for, so a parser that reads `1::2::3` as `1::2` lets an invalid string match a
 * real SAN. Every form below is either exactly right or refused.
 */
export const parseIpAddress = (text: string): Uint8Array | null => {
  const quad = IPV4.exec(text);
  if (quad !== null) {
    // `010` is not `10` in an address literal, and reading it as one is how a
    // non-canonical spelling matches a canonical SAN.
    if (/(^|\.)0\d/.test(text)) return null;
    const parts = quad.slice(1).map(Number);
    return parts.every(part => part <= 255) ? Uint8Array.from(parts) : null;
  }
  if (!text.includes(':')) return null;

  // Exactly zero or one compression marker; `1::2::3` is not an address.
  const sections = text.split('::');
  if (sections.length > 2) return null;
  const [head = '', tail] = sections;

  /** Hex words, with an optional dotted-quad tail contributing the last two. */
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
  // Uncompressed must be exactly 8 words; compressed must stand for at least one.
  if (tail === undefined ? total !== 8 : total >= 8) return null;
  const words = [...left, ...Array.from({ length: 8 - total }, () => 0), ...right];
  return Uint8Array.from(words.flatMap(word => [word >> 8, word & 0xff]));
};

const isSameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Does the leaf present the name the caller asked for? CN is deliberately never
 * consulted: `webpki::cn` expects a certificate whose only match is its CN to
 * FAIL, which is what every browser has done for a decade.
 */
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

/**
 * `null` is "this pair is not something we can evaluate". It is NOT "no match":
 * `violatesConstraints` turns it into a refusal in BOTH directions, because a
 * constraint we cannot apply must never read as one that was satisfied.
 */
type SubtreeVerdict = boolean | null;

/**
 * A DNS name constraint covers a name and everything to its left: `example.com`
 * covers `example.com` and `a.example.com`, never `notexample.com`. An empty
 * constraint covers every DNS name, which is how an excluded-everything subtree
 * is written.
 */
const dnsWithinSubtree = (name: string, constraint: string): SubtreeVerdict => {
  const target = asciiLower(name);
  const base = asciiLower(constraint);
  if (base === '') return true;
  // RFC 5280 s4.2.1.10 gives dNSName no leading-dot form. A constraint written
  // that way is one we cannot honour, so it is unprocessable rather than unmet.
  if (base.startsWith('.')) return null;
  if (!isComparableHostname(target)) return false;
  return target === base || target.endsWith(`.${base}`);
};

/**
 * A wildcard SAN against a subtree, and the two directions are NOT the same
 * question — which is a certificate-validation bypass if one helper answers both.
 *
 * PERMITTED asks "is everything this can authenticate inside the subtree?", so
 * `*.example.com` is permitted by `example.com`: strip the wildcard and test the
 * base. EXCLUDED asks "can this authenticate ANYTHING inside the subtree?", so
 * `*.example.com` must be refused by an exclusion of `bar.example.com` — the
 * wildcard authenticates exactly that host. Stripping the wildcard for both
 * makes the exclusion miss, and a name-constrained CA can then issue a wildcard
 * covering the host it was specifically forbidden. That is `cve::cve-2025-61727`.
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
  // A bracketed IPv6 literal keeps its own colons, so strip the brackets here
  // and let the caller decide that an address is not a domain.
  const bracketed = /^\[(.+)\]/.exec(afterUserInfo);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const host = afterUserInfo.split(':')[0];
  return host === undefined || host === '' ? null : host;
};

/**
 * RFC 5280 s4.2.1.10 gives URIs their OWN rule, and it is not the dNSName rule.
 * A constraint without a leading period names one EXACT host; with a leading
 * period it names proper subdomains and not the bare domain. Sending URIs
 * through the DNS matcher makes `example.com` cover `sub.example.com`, which the
 * constraint never said.
 *
 * A URI with no authority host, or with an IP-literal host, cannot be compared
 * against a domain constraint at all — unprocessable, not unmatched.
 */
const uriWithinSubtree = (uri: string, constraint: string): SubtreeVerdict => {
  const host = hostOfUri(uri);
  if (host === null) return null;
  if (parseIpAddress(host) !== null) return null;
  const target = asciiLower(host);
  if (!isComparableHostname(target)) return null;
  const base = asciiLower(constraint);
  // The constraint "MUST be specified as a fully qualified domain name", so an
  // empty one states nothing we can apply.
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

/** An IP constraint is address followed by mask: 8 octets for v4, 32 for v6. */
const ipWithinSubtree = (address: Uint8Array, constraint: Uint8Array): SubtreeVerdict => {
  if (constraint.length !== address.length * 2) {
    // A constraint of the other family is a plain non-match. A constraint of
    // neither family is a shape we cannot apply.
    return constraint.length === 8 || constraint.length === 32 ? false : null;
  }
  return address.every((byte, index) => {
    const base = constraint[index] ?? 0;
    const mask = constraint[address.length + index] ?? 0;
    return (byte & mask) === (base & mask);
  });
};

/**
 * The string types a DirectoryString can use, and how to read each one. A type
 * absent here yields an unprocessable comparison rather than a locally invented
 * key — two different values must never collapse onto one identity.
 */
const STRING_ENCODINGS: Readonly<Record<number, string>> = {
  12: 'utf-8',
  19: 'ascii',
  20: 'ascii',
  22: 'ascii',
  30: 'utf-16be',
};

/**
 * RFC 4518 string preparation, to the extent a certificate needs it: compatibility
 * normalisation, insignificant spaces folded, then case folding.
 *
 * `toLowerCase` is the right tool and is locale-INDEPENDENT — it is
 * `toLocaleLowerCase` that maps the Turkish dotted I. ASCII-only folding, which
 * this used to do, leaves `O=ÉVIL` and `O=évil` as different organisations, and
 * an excluded directory subtree is then evaded by changing case.
 */
const prepareForComparison = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One attribute as a comparable key, or `null` when it cannot be prepared.
 *
 * Decoding is FATAL on purpose. A lenient decoder maps every invalid sequence to
 * U+FFFD, which collapses distinct values onto one identity — the same hazard as
 * an unpadded hex fallback, where `04 00` and `40` both read as "400".
 */
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

/** One RDN is a SET, so its attributes carry no order to compare positionally. */
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

/** A DN constraint is satisfied when its RDNs are a prefix of the subject's. */
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

/**
 * Whether one name falls inside one subtree, or `null` when the pair is a form
 * this implementation cannot evaluate.
 */
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

/** Every constraint in force, accumulated down the chain. */
export type ConstraintState = {
  /**
   * One entry per certificate that stated permittedSubtrees, kept SEPARATE.
   * Flattening them into one list turns intersection into union, which would let
   * an intermediate widen the names its own issuer permitted it — the exact
   * thing name constraints exist to prevent.
   */
  readonly permittedLevels: readonly (readonly GeneralSubtree[])[];
  readonly excluded: readonly GeneralSubtree[];
};

export const EMPTY_CONSTRAINTS: ConstraintState = { permittedLevels: [], excluded: [] };

/**
 * RFC 5280 s6.1.4(g). Permitted subtrees INTERSECT down the chain and excluded
 * subtrees UNION. The two directions are what make a CA unable to widen its own
 * authority by issuing itself a laxer intermediate.
 */
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

/**
 * RFC 5280 s6.1.3(b)(c), applied to one certificate's names.
 *
 * A name is refused if it falls inside any excluded subtree, or if any LEVEL
 * that constrains its name form fails to cover it. A level that states no
 * subtree of that form does not constrain it — that is the rule keeping a
 * DNS-only constraint from silently forbidding every email address.
 */
/**
 * A ceiling on name-constraint comparisons, and it is a SECURITY control rather
 * than a performance tweak. `pathological::nc-dos-1` presents 2048 SANs against
 * 4097 subtrees — 8.4 million comparisons for a chain that is otherwise
 * perfectly valid — and x509-limbo expects it REFUSED. rustls-webpki carries the
 * same kind of bound for the same reason.
 *
 * Real certificates are nowhere near: the whole harvested corpus tops out at a
 * handful of SANs against no constraints at all.
 */
const MAXIMUM_NAME_COMPARISONS = 250_000;

/**
 * RFC 5280 s6.1.3(b)(c), applied to one certificate's names.
 *
 * A name is refused if it falls inside any excluded subtree, or if any LEVEL
 * that constrains its name form fails to cover it. A level that states no
 * subtree of that form does not constrain it — the rule keeping a DNS-only
 * constraint from silently forbidding every email address.
 *
 * Loops rather than `some`/`every` because the comparison budget has to be
 * decremented and checked between every single comparison, and exhausting it
 * must read as a REFUSAL: a certificate we could not finish clearing is not a
 * certificate we cleared.
 */
export const violatesConstraints = (
  names: readonly GeneralName[],
  state: ConstraintState,
): boolean => {
  let budget = MAXIMUM_NAME_COMPARISONS;
  // Grouped once rather than filtered per name: with 2048 names and 2049
  // subtrees, re-filtering is itself the denial of service.
  const permittedByKind = state.permittedLevels.map(level =>
    Map.groupBy(level, ({ base }) => base.kind),
  );

  for (const name of names) {
    for (const { base } of state.excluded) {
      if (budget <= 0) return true;
      budget -= 1;
      // `null` is a form we cannot evaluate, and an exclusion we cannot evaluate
      // must never read as one that was satisfied.
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
