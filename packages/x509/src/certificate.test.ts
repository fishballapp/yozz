/**
 * The structural rules M3 enforces, each stated as one malformation of an
 * otherwise valid certificate.
 *
 * Built rather than harvested, for the same reason M2's reject-list is authored:
 * every real certificate is well-formed by construction, so a corpus proves that
 * valid input decodes and nothing about what invalid input does. The builder
 * below is the smallest thing that can express "this certificate, but with two
 * BasicConstraints".
 */
import { describe, expect, it } from 'vitest';
import { decodeCertificate } from './certificate.ts';
import { DerError, type DerFailureCode } from './der.ts';

const encodeLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const octets: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    octets.unshift(remaining % 256);
  }
  return [0x80 | octets.length, ...octets];
};

const tlv = (tag: number, ...content: readonly Uint8Array[]): Uint8Array => {
  const body = content.flatMap(part => [...part]);
  return Uint8Array.from([tag, ...encodeLength(body.length), ...body]);
};

const bytes = (...values: readonly number[]): Uint8Array => Uint8Array.from(values);
const integer = (value: number): Uint8Array => tlv(0x02, bytes(value));
const asBoolean = (value: boolean): Uint8Array => tlv(0x01, bytes(value ? 0xff : 0x00));
const octets = (...values: readonly number[]): Uint8Array => tlv(0x04, bytes(...values));
const bitString = (...values: readonly number[]): Uint8Array => tlv(0x03, bytes(0, ...values));
const utf8 = (text: string): Uint8Array => tlv(0x0c, new TextEncoder().encode(text));
/** One octet per code unit, so a test can put a byte IA5String cannot hold into one. */
const chars = (tag: number, text: string): Uint8Array =>
  tlv(tag, Uint8Array.from([...text].map(character => character.charCodeAt(0))));
const utcTime = (text: string): Uint8Array => chars(0x17, text);
const sequence = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x30, ...content);
const set = (...content: readonly Uint8Array[]): Uint8Array => tlv(0x31, ...content);
const explicit = (tagNumber: number, ...content: readonly Uint8Array[]): Uint8Array =>
  tlv(0xa0 | tagNumber, ...content);

const oid = (dotted: string): Uint8Array => {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const base128 = (value: number): number[] => {
    const digits = [value % 128];
    for (let n = Math.floor(value / 128); n > 0; n = Math.floor(n / 128)) {
      digits.unshift((n % 128) | 0x80);
    }
    return digits;
  };
  return tlv(0x06, bytes(first * 40 + second, ...rest.flatMap(base128)));
};

const SHA256_WITH_RSA = sequence(oid('1.2.840.113549.1.1.11'), tlv(0x05));
const commonName = (value: string): Uint8Array =>
  sequence(set(sequence(oid('2.5.4.3'), utf8(value))));

/** A v3 certificate that decodes, so each test below changes exactly one thing. */
const certificate = ({
  version = explicit(0, integer(2)),
  signatureAlgorithm = SHA256_WITH_RSA,
  innerSignature = SHA256_WITH_RSA,
  issuer = commonName('Issuing CA'),
  subject = commonName('leaf.example'),
  extensions = [] as readonly Uint8Array[],
}: {
  version?: Uint8Array | null;
  signatureAlgorithm?: Uint8Array;
  innerSignature?: Uint8Array;
  issuer?: Uint8Array;
  subject?: Uint8Array;
  extensions?: readonly Uint8Array[];
} = {}): Uint8Array =>
  sequence(
    sequence(
      ...(version === null ? [] : [version]),
      integer(1),
      innerSignature,
      issuer,
      sequence(utcTime('240101000000Z'), utcTime('340101000000Z')),
      subject,
      sequence(sequence(oid('1.2.840.113549.1.1.1'), tlv(0x05)), bitString(0x01, 0x02)),
      ...(extensions.length === 0 ? [] : [explicit(3, sequence(...extensions))]),
    ),
    signatureAlgorithm,
    bitString(0xde, 0xad),
  );

const extension = (extnOid: string, value: Uint8Array, isCritical = false): Uint8Array =>
  sequence(oid(extnOid), ...(isCritical ? [asBoolean(true)] : []), tlv(0x04, value));

const rejectionOf = (der: Uint8Array): DerError => {
  try {
    decodeCertificate(der);
  } catch (error) {
    if (error instanceof DerError) return error;
    throw error;
  }
  throw new Error('expected a DerError, but nothing was thrown');
};

const rejects = (der: Uint8Array, code: DerFailureCode): void => {
  expect(rejectionOf(der).code).toBe(code);
};

describe('the baseline', () => {
  it('decodes, so every rejection below is about the one thing it changed', () => {
    const decoded = decodeCertificate(certificate());
    expect(decoded.version).toBe(3);
    expect(decoded.serialNumber).toBe(1n);
    expect(decoded.subject.relativeDistinguishedNames).toHaveLength(1);
    expect(decoded.extensions.unrecognisedCritical).toEqual([]);
  });

  it('keeps tbsCertificate as a view of the input, never a rebuild', () => {
    const der = certificate();
    expect(decodeCertificate(der).tbsCertificateDer.buffer).toBe(der.buffer);
  });
});

describe('version', () => {
  it('reads an absent version field as v1', () => {
    expect(decodeCertificate(certificate({ version: null })).version).toBe(1);
  });

  /** DER omits a DEFAULT, so an explicit v1 is different bytes for the same certificate. */
  it('rejects an explicitly encoded v1', () => {
    rejects(certificate({ version: explicit(0, integer(0)) }), 'malformed-structure');
  });

  it('rejects a version nobody defined', () => {
    rejects(certificate({ version: explicit(0, integer(4)) }), 'malformed-value');
  });

  it('rejects extensions in a certificate that is not v3', () => {
    rejects(
      certificate({ version: null, extensions: [extension('2.5.29.19', sequence())] }),
      'malformed-structure',
    );
  });
});

describe('the signature algorithm appears twice and must agree', () => {
  /**
   * RFC 5280 s4.1.1.2. The outer copy is unsigned, so an implementation that
   * picks its verification algorithm from it, on a certificate where the two
   * differ, is taking direction from an attacker.
   */
  it('rejects a mismatch between tbsCertificate.signature and signatureAlgorithm', () => {
    rejects(
      certificate({ signatureAlgorithm: sequence(oid('1.2.840.113549.1.1.13'), tlv(0x05)) }),
      'malformed-structure',
    );
  });

  it('rejects a mismatch in the parameters alone, not just the OID', () => {
    rejects(
      certificate({ innerSignature: sequence(oid('1.2.840.113549.1.1.11')) }),
      'malformed-structure',
    );
  });
});

describe('extensions', () => {
  it('rejects the same extension twice', () => {
    rejects(
      certificate({
        extensions: [
          extension('2.5.29.19', sequence(asBoolean(true))),
          extension('2.5.29.19', sequence()),
        ],
      }),
      'malformed-structure',
    );
  });

  it('rejects an empty extensions SEQUENCE, which RFC 5280 cannot encode', () => {
    const der = sequence(
      sequence(
        explicit(0, integer(2)),
        integer(1),
        SHA256_WITH_RSA,
        commonName('CA'),
        sequence(utcTime('240101000000Z'), utcTime('340101000000Z')),
        commonName('leaf'),
        sequence(sequence(oid('1.2.840.113549.1.1.1'), tlv(0x05)), bitString(1)),
        explicit(3, sequence()),
      ),
      SHA256_WITH_RSA,
      bitString(0xde),
    );
    rejects(der, 'malformed-structure');
  });

  /**
   * Entrust's private extension holds a GeneralString, which RFC 5280 admits
   * nowhere. Decoding every extension eagerly rejects a root that Node and every
   * browser trust — so an extension we do not interpret is not parsed at all.
   */
  it('does not parse the contents of an extension it does not recognise', () => {
    const generalString = tlv(0x1b, new TextEncoder().encode('V7.1:4.0'));
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('1.2.840.113533.7.65.0', sequence(generalString))] }),
    );
    expect(decoded.extensions.unrecognisedCritical).toEqual([]);
  });

  it('records an unrecognised CRITICAL extension for M4 to fail closed on', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('1.3.6.1.4.1.99999.1', octets(1), true)] }),
    );
    expect(decoded.extensions.unrecognisedCritical).toEqual(['1.3.6.1.4.1.99999.1']);
  });
});

describe('BasicConstraints', () => {
  it('reads pathlen 0 as zero, not as absent', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.19', sequence(asBoolean(true), integer(0)))] }),
    );
    expect(decoded.extensions.basicConstraints?.value).toEqual({
      isCa: true,
      maximumPathLength: 0,
    });
  });

  it('reads an absent pathlen as unlimited, which is not zero', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.19', sequence(asBoolean(true)))] }),
    );
    expect(decoded.extensions.basicConstraints?.value.maximumPathLength).toBeNull();
  });

  it('reads an absent cA as false', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.19', sequence())] }),
    );
    expect(decoded.extensions.basicConstraints?.value.isCa).toBe(false);
  });
});

describe('KeyUsage', () => {
  /** Bit 0 is the MOST significant bit of the first octet (X.690 s8.6.2). */
  it('reads digitalSignature from the top bit, not the bottom one', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.15', tlv(0x03, bytes(7, 0x80)))] }),
    );
    expect([...(decoded.extensions.keyUsage?.value ?? [])]).toEqual(['digitalSignature']);
  });

  it('reads keyCertSign and cRLSign out of the second octet', () => {
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.15', tlv(0x03, bytes(1, 0x06, 0x00)))] }),
    );
    expect([...(decoded.extensions.keyUsage?.value ?? [])]).toEqual(['keyCertSign', 'cRLSign']);
  });
});

describe('names', () => {
  /** Built from a char code, so the byte under test is visible rather than invisible. */
  const POISONED = ['evil.com', '.good.example'].join(String.fromCharCode(0));

  /**
   * Truncated at the NUL this reads as `evil.com` — a name no CA ever issued,
   * and how a name check gets fooled. The NUL survives decoding; rejecting it is
   * the matcher's job at M4, which it can only do if the bytes arrive intact.
   */
  it('keeps an embedded NUL in a dNSName rather than truncating there', () => {
    const san = sequence(chars(0x82, POISONED));
    const decoded = decodeCertificate(certificate({ extensions: [extension('2.5.29.17', san)] }));
    const [name] = decoded.extensions.subjectAltName?.value ?? [];
    expect(name).toEqual({ kind: 'dns', value: POISONED });
    expect(name?.kind === 'dns' && name.value).toHaveLength(22);
  });

  it('rejects a dNSName carrying bytes IA5String cannot hold', () => {
    const san = sequence(tlv(0x82, bytes(0xf0, 0x9f, 0x92, 0xa9)));
    rejects(certificate({ extensions: [extension('2.5.29.17', san)] }), 'malformed-value');
  });

  it('rejects an RDN holding no attributes, which makes two names compare equal', () => {
    rejects(certificate({ subject: sequence(set()) }), 'malformed-structure');
  });

  it('decodes an empty Name, which is legal and means something at M4', () => {
    expect(
      decodeCertificate(certificate({ issuer: sequence() })).issuer.relativeDistinguishedNames,
    ).toEqual([]);
  });
});

describe('NameConstraints', () => {
  it('decodes permitted and excluded subtrees', () => {
    const constraints = sequence(
      explicit(0, sequence(chars(0x82, 'permitted.example'))),
      explicit(1, sequence(chars(0x82, 'excluded.example'))),
    );
    const decoded = decodeCertificate(
      certificate({ extensions: [extension('2.5.29.30', constraints, true)] }),
    );
    expect(decoded.extensions.nameConstraints?.value).toEqual({
      permitted: [{ base: { kind: 'dns', value: 'permitted.example' } }],
      excluded: [{ base: { kind: 'dns', value: 'excluded.example' } }],
    });
  });

  /**
   * RFC 5280 s4.2.1.10 forbids minimum/maximum in this profile. Rejected rather
   * than ignored: a constraint carrying a range we skipped is one that silently
   * constrains less than it claims.
   */
  it('rejects a GeneralSubtree carrying minimum or maximum', () => {
    const constraints = sequence(
      explicit(0, sequence(chars(0x82, 'permitted.example'), tlv(0x80, bytes(1)))),
    );
    rejects(
      certificate({ extensions: [extension('2.5.29.30', constraints, true)] }),
      'malformed-structure',
    );
  });

  it('rejects NameConstraints stating neither permitted nor excluded', () => {
    rejects(
      certificate({ extensions: [extension('2.5.29.30', sequence(), true)] }),
      'malformed-structure',
    );
  });
});
