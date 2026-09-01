import { describe, expect, it } from 'vitest';
import type { AttributeTypeAndValue, GeneralName } from './certificate.ts';
import {
  addConstraints,
  EMPTY_CONSTRAINTS,
  matchesDnsName,
  matchesPeerName,
  parseIpAddress,
  violatesConstraints,
} from './names.ts';

const dns = (value: string): GeneralName => ({ kind: 'dns', value });
const ip = (value: string): GeneralName => {
  const bytes = parseIpAddress(value);
  if (bytes === null) throw new Error(`not an address: ${value}`);
  return { kind: 'ip', bytes };
};

describe('matchesDnsName', () => {
  it.each([
    ['exact', 'a.example.com', 'a.example.com', true],
    ['case-insensitive', 'A.Example.COM', 'a.example.com', true],
    ['a different host', 'b.example.com', 'a.example.com', false],
    ['a suffix that is not a label boundary', 'example.com', 'notexample.com', false],
    ['a wildcard over one label', '*.example.com', 'a.example.com', true],
    ['a wildcard over two labels', '*.example.com', 'a.b.example.com', false],
    ['a wildcard against the bare domain', '*.example.com', 'example.com', false],
    ['a partial-label wildcard', 'www*.example.com', 'wwwx.example.com', false],
    ['a wildcard that is not leftmost', 'a.*.example.com', 'a.b.example.com', false],
    ['a wildcard over a single label', '*.com', 'example.com', false],
    ['a wildcard against an A-label', '*.example.com', 'xn--caf-dma.example.com', false],
    ['a trailing dot', 'a.example.com.', 'a.example.com', false],
    ['an empty label', 'a..example.com', 'a..example.com', false],
  ])('%s', (_why, presented, host, expected) => {
    expect(matchesDnsName(presented, host)).toBe(expected);
  });

  /** A NUL survives M3 intact precisely so this comparison can refuse it. */
  it('refuses a name carrying an embedded NUL rather than truncating', () => {
    const poisoned = ['evil.com', '.good.example'].join(String.fromCharCode(0));
    expect(matchesDnsName(poisoned, 'evil.com')).toBe(false);
  });
});

describe('parseIpAddress', () => {
  it('reads dotted quads', () => {
    expect([...(parseIpAddress('192.0.2.1') ?? [])]).toEqual([192, 0, 2, 1]);
  });

  it('reads a compressed IPv6 address', () => {
    expect(parseIpAddress('2001:db8::1')?.length).toBe(16);
    expect([...(parseIpAddress('::1') ?? [])].at(-1)).toBe(1);
  });

  it('refuses an octet out of range', () => {
    expect(parseIpAddress('192.0.2.256')).toBeNull();
  });

  it.each([
    ['a second compression marker', '1::2::3'],
    ['a non-hex word', '1:2:3:4:5:6:7:1g'],
    ['too few words without compression', '1:2:3:4:5:6:7'],
    ['too many words', '1:2:3:4:5:6:7:8:9'],
    ['a compression standing for no word', '1:2:3:4:5:6:7::8'],
    ['leading zeros in a quad', '192.168.001.001'],
    ['a five-digit hex word', '1:2:3:4:5:6:7:12345'],
  ])('refuses %s', (_why, text) => {
    expect(parseIpAddress(text)).toBeNull();
  });

  it('reads the IPv4-tail form, which is a legitimate address literal', () => {
    expect([...(parseIpAddress('::ffff:192.0.2.1') ?? [])]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 0, 2, 1,
    ]);
  });

  it('reads a fully written-out address', () => {
    expect(
      [...(parseIpAddress('2001:0db8:0000:0000:0000:0000:0000:0001') ?? [])].slice(0, 4),
    ).toEqual([0x20, 0x01, 0x0d, 0xb8]);
  });
});

describe('matchesPeerName', () => {
  it('never consults the common name — only SANs count', () => {
    expect(matchesPeerName([], { kind: 'dns', value: 'a.example.com' })).toBe(false);
  });

  it('matches an IP SAN by bytes', () => {
    expect(matchesPeerName([ip('192.0.2.1')], { kind: 'ip', value: '192.0.2.1' })).toBe(true);
    expect(matchesPeerName([ip('192.0.2.1')], { kind: 'ip', value: '192.0.2.2' })).toBe(false);
  });

  it('does not match a DNS SAN against an expected IP', () => {
    expect(matchesPeerName([dns('192.0.2.1')], { kind: 'ip', value: '192.0.2.1' })).toBe(false);
  });
});

describe('name constraints', () => {
  const withConstraints = (permitted: readonly GeneralName[], excluded: readonly GeneralName[]) =>
    addConstraints(EMPTY_CONSTRAINTS, {
      permitted: permitted.map(base => ({ base })),
      excluded: excluded.map(base => ({ base })),
    });

  it('permits a name inside the subtree and everything left of it', () => {
    const state = withConstraints([dns('example.com')], []);
    expect(violatesConstraints([dns('example.com')], state)).toBe(false);
    expect(violatesConstraints([dns('a.example.com')], state)).toBe(false);
    expect(violatesConstraints([dns('notexample.com')], state)).toBe(true);
  });

  it('excludes a subtree even when it is also permitted', () => {
    const state = withConstraints([dns('example.com')], [dns('bad.example.com')]);
    expect(violatesConstraints([dns('bad.example.com')], state)).toBe(true);
    expect(violatesConstraints([dns('good.example.com')], state)).toBe(false);
  });

  /** The rule that keeps a DNS-only constraint from forbidding every address. */
  it('leaves a name form with no permitted subtree unconstrained', () => {
    const state = withConstraints([dns('example.com')], []);
    expect(violatesConstraints([ip('192.0.2.1')], state)).toBe(false);
  });

  it('matches an IP constraint through its mask', () => {
    const subtree: GeneralName = {
      kind: 'ip',
      bytes: Uint8Array.from([192, 0, 2, 0, 255, 255, 255, 0]),
    };
    const state = withConstraints([subtree], []);
    expect(violatesConstraints([ip('192.0.2.99')], state)).toBe(false);
    expect(violatesConstraints([ip('192.0.3.1')], state)).toBe(true);
  });

  /** Permitted subtrees intersect down the chain. */
  it('intersects permitted subtrees rather than replacing them', () => {
    const parent = withConstraints([dns('example.com')], []);
    const child = addConstraints(parent, {
      permitted: [{ base: dns('other.test') }],
      excluded: [],
    });
    expect(violatesConstraints([dns('a.example.com')], child)).toBe(true);
    expect(violatesConstraints([dns('a.other.test')], child)).toBe(true);
  });

  it('unions excluded subtrees down the chain', () => {
    const parent = withConstraints([], [dns('bad.test')]);
    const child = addConstraints(parent, {
      permitted: [],
      excluded: [{ base: dns('worse.test') }],
    });
    expect(violatesConstraints([dns('a.bad.test')], child)).toBe(true);
    expect(violatesConstraints([dns('a.worse.test')], child)).toBe(true);
    expect(violatesConstraints([dns('fine.test')], child)).toBe(false);
  });

  /** An unsupported form in an excluded subtree refuses the name. */
  it('fails closed on an excluded subtree it cannot interpret', () => {
    const other: GeneralName = { kind: 'other', tagNumber: 3, bytes: Uint8Array.of(1) };
    const state = withConstraints([], [other]);
    expect(
      violatesConstraints([{ kind: 'other', tagNumber: 3, bytes: Uint8Array.of(9) }], state),
    ).toBe(true);
  });
});

/** CVE-2025-61727: permitted and excluded ask different questions of a wildcard. */
describe('a wildcard SAN against a name constraint', () => {
  const constrain = (permitted: readonly GeneralName[], excluded: readonly GeneralName[]) =>
    addConstraints(EMPTY_CONSTRAINTS, {
      permitted: permitted.map(base => ({ base })),
      excluded: excluded.map(base => ({ base })),
    });

  it('is EXCLUDED by a subtree it can expand into', () => {
    const state = constrain([dns('example.com')], [dns('bar.example.com')]);
    expect(violatesConstraints([dns('*.example.com')], state)).toBe(true);
  });

  it('is excluded by a subtree that contains its whole base', () => {
    const state = constrain([], [dns('example.com')]);
    expect(violatesConstraints([dns('*.example.com')], state)).toBe(true);
  });

  it('is not excluded by an unrelated subtree', () => {
    const state = constrain([dns('example.com')], [dns('other.test')]);
    expect(violatesConstraints([dns('*.example.com')], state)).toBe(false);
  });

  /** The permitted direction still strips the wildcard, which is what WebPKI wants. */
  it('is PERMITTED by the subtree its base sits in', () => {
    const state = constrain([dns('example.com')], []);
    expect(violatesConstraints([dns('*.example.com')], state)).toBe(false);
  });

  it('is not permitted by a subtree its base sits outside', () => {
    const state = constrain([dns('other.test')], []);
    expect(violatesConstraints([dns('*.example.com')], state)).toBe(true);
  });
});

/** RFC 5280 §7.1 name comparison. No x509-limbo case covers this. */
describe('distinguished names inside a directory subtree', () => {
  const PRINTABLE = 0x13;
  const UTF8 = 0x0c;

  const attribute = (oid: string, tag: number, text: string): AttributeTypeAndValue => {
    const content = new TextEncoder().encode(text);
    return { oid, valueDer: Uint8Array.from([tag, content.length, ...content]) };
  };
  const directory = (...rdns: readonly (readonly AttributeTypeAndValue[])[]): GeneralName => ({
    kind: 'directory',
    name: { der: Uint8Array.of(), relativeDistinguishedNames: rdns },
  });
  const ORGANISATION = '2.5.4.10';
  const COMMON_NAME = '2.5.4.3';

  const isExcludedBy = (subject: GeneralName, subtree: GeneralName): boolean =>
    violatesConstraints(
      [subject],
      addConstraints(EMPTY_CONSTRAINTS, { permitted: [], excluded: [{ base: subtree }] }),
    );

  const excluded = directory([attribute(ORGANISATION, PRINTABLE, 'Acme')]);

  it('excludes the same name spelled in a different string type', () => {
    expect(isExcludedBy(directory([attribute(ORGANISATION, UTF8, 'Acme')]), excluded)).toBe(true);
  });

  it('excludes the same name in a different case', () => {
    expect(isExcludedBy(directory([attribute(ORGANISATION, PRINTABLE, 'ACME')]), excluded)).toBe(
      true,
    );
  });

  it('excludes the same name with insignificant spacing', () => {
    const spaced = directory([attribute(ORGANISATION, PRINTABLE, '  Acme  ')]);
    expect(isExcludedBy(spaced, excluded)).toBe(true);
  });

  it('still excludes a name below the subtree', () => {
    const below = directory(
      [attribute(ORGANISATION, PRINTABLE, 'Acme')],
      [attribute(COMMON_NAME, PRINTABLE, 'mail')],
    );
    expect(isExcludedBy(below, excluded)).toBe(true);
  });

  /** ASCII-only folding left these as different organisations. */
  it('excludes the same name differing only in non-ASCII case', () => {
    const accented = directory([attribute(ORGANISATION, UTF8, 'ÉVIL')]);
    const excludedAccented = directory([attribute(ORGANISATION, UTF8, 'évil')]);
    expect(isExcludedBy(accented, excludedAccented)).toBe(true);
  });

  /** An encoding that cannot be prepared refuses; an unpadded hex fallback once collapsed two UniversalStrings onto one key. */
  it('refuses a directory name whose string type it cannot prepare', () => {
    const universalString = (bytes: readonly number[]): AttributeTypeAndValue => ({
      oid: ORGANISATION,
      valueDer: Uint8Array.from([0x1c, bytes.length, ...bytes]),
    });
    const permitted = directory([universalString([0x00, 0x00, 0x01, 0x23])]);
    const other = directory([universalString([0x00, 0x00, 0x12, 0x03])]);
    expect(
      violatesConstraints(
        [other],
        addConstraints(EMPTY_CONSTRAINTS, { permitted: [{ base: permitted }], excluded: [] }),
      ),
    ).toBe(true);
  });

  it('does not exclude a genuinely different organisation', () => {
    expect(isExcludedBy(directory([attribute(ORGANISATION, PRINTABLE, 'Other')]), excluded)).toBe(
      false,
    );
  });

  /** One RDN is a SET, so its attributes carry no order to compare positionally. */
  it('matches an RDN whose attributes are written in another order', () => {
    const subtree = directory([
      attribute(ORGANISATION, PRINTABLE, 'Acme'),
      attribute(COMMON_NAME, PRINTABLE, 'mail'),
    ]);
    const reordered = directory([
      attribute(COMMON_NAME, PRINTABLE, 'mail'),
      attribute(ORGANISATION, PRINTABLE, 'Acme'),
    ]);
    expect(isExcludedBy(reordered, subtree)).toBe(true);
  });
});

/** A constraint that cannot be evaluated refuses in both directions; `false` in the excluded direction would mean the exclusion does not apply. */
describe('constraints that cannot be evaluated', () => {
  const constrain = (permitted: readonly GeneralName[], excluded: readonly GeneralName[]) =>
    addConstraints(EMPTY_CONSTRAINTS, {
      permitted: permitted.map(base => ({ base })),
      excluded: excluded.map(base => ({ base })),
    });
  const uri = (value: string): GeneralName => ({ kind: 'uri', value });

  it('refuses a DNS name against a leading-period constraint, which RFC 5280 has no form for', () => {
    expect(
      violatesConstraints([dns('foo.example.com')], constrain([], [dns('.example.com')])),
    ).toBe(true);
  });

  it('refuses an IP whose excluded subtree is neither 8 nor 32 octets', () => {
    const malformed: GeneralName = { kind: 'ip', bytes: Uint8Array.of(192, 0, 2, 0, 255) };
    expect(violatesConstraints([ip('192.0.2.1')], constrain([], [malformed]))).toBe(true);
  });

  /** RFC 5280 s4.2.1.10: a URI constraint without a period names ONE host. */
  it('does not let a bare URI constraint cover subdomains the way a DNS one does', () => {
    const state = constrain([uri('example.com')], []);
    expect(violatesConstraints([uri('https://sub.example.com/')], state)).toBe(true);
    expect(violatesConstraints([uri('https://example.com/')], state)).toBe(false);
  });

  it('honours the leading-period URI form, which names proper subdomains only', () => {
    const state = constrain([], [uri('.example.com')]);
    expect(violatesConstraints([uri('https://sub.example.com/')], state)).toBe(true);
    expect(violatesConstraints([uri('https://example.com/')], state)).toBe(false);
  });

  it('refuses a URI with no authority host while a URI constraint is in force', () => {
    expect(
      violatesConstraints([uri('mailto:user@example.com')], constrain([], [uri('example.com')])),
    ).toBe(true);
  });

  it('refuses a URI whose host is an IP literal', () => {
    expect(
      violatesConstraints([uri('https://192.0.2.1/')], constrain([], [uri('example.com')])),
    ).toBe(true);
  });
});
