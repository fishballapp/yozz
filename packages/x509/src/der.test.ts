import { describe, expect, it } from 'vitest';
import {
  DerError,
  type DerFailureCode,
  decodeBitString,
  decodeBoolean,
  decodeDer,
  decodeInteger,
  decodeOid,
  decodeTime,
} from './der.ts';

/** Hex with whitespace, so a vector's TLV structure stays visible: `30 03 02 01 05`. */
const der = (hex: string): Uint8Array => {
  const digits = hex.replace(/\s+/g, '');
  if (!/^([0-9a-f]{2})*$/i.test(digits)) throw new Error(`not whole hex bytes: ${hex}`);
  return Uint8Array.from(digits.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
};

/** Length vectors write their bytes by hand: a helper that encodes the length cannot express a malformed one. */
const tlv = (tag: number, content: Uint8Array): Uint8Array =>
  Uint8Array.from([tag, content.length, ...content]);

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Returns the DerError and re-throws anything else: only our own failure type may escape. */
const rejectionOf = (run: () => unknown): DerError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DerError) return error;
    throw error;
  }
  throw new Error('expected a DerError, but nothing was thrown');
};

type Rejection = { readonly why: string; readonly bytes: string; readonly code: DerFailureCode };

const rejects = (cases: readonly Rejection[]): void => {
  it.each(cases)('rejects $why', ({ bytes, code }) => {
    expect(rejectionOf(() => decodeDer(der(bytes))).code).toBe(code);
  });
};

describe('the TLV skeleton', () => {
  it('decodes a primitive with empty content', () => {
    const node = decodeDer(der('05 00'));
    expect(node).toMatchObject({
      tagClass: 'universal',
      tagNumber: 5,
      isConstructed: false,
      offset: 0,
    });
    expect(node.content).toHaveLength(0);
    expect([...node.bytes]).toEqual([0x05, 0x00]);
  });

  it('decodes an empty SEQUENCE as constructed with no children', () => {
    const node = decodeDer(der('30 00'));
    expect(node.isConstructed && node.children).toEqual([]);
  });

  it('decodes a SEQUENCE of one INTEGER', () => {
    const node = decodeDer(der('30 03 02 01 05'));
    if (!node.isConstructed) throw new Error('expected a constructed node');
    expect(node.children).toHaveLength(1);
    expect([...(node.children[0]?.bytes ?? [])]).toEqual([0x02, 0x01, 0x05]);
    // The child's offset is absolute in the input, not relative to its parent.
    expect(node.children[0]?.offset).toBe(2);
  });

  it('decodes nesting', () => {
    const node = decodeDer(der('30 05 30 03 02 01 05'));
    if (!node.isConstructed) throw new Error('expected a constructed node');
    const inner = node.children[0];
    if (inner === undefined || !inner.isConstructed) throw new Error('expected an inner SEQUENCE');
    expect(inner.children[0]?.tagNumber).toBe(2);
  });

  it('reads long-form lengths', () => {
    const input = Uint8Array.from([0x04, 0x81, 0x80, ...Array.from({ length: 128 }, () => 0)]);
    expect(decodeDer(input).content).toHaveLength(128);
  });

  it('decodes a context-specific constructed tag, which is how [0] EXPLICIT version arrives', () => {
    const node = decodeDer(der('A0 03 02 01 02'));
    expect(node).toMatchObject({ tagClass: 'context', tagNumber: 0, isConstructed: true });
  });

  it('decodes a context-specific primitive tag, which is how a dNSName SAN arrives', () => {
    const node = decodeDer(der('82 03 61 62 63'));
    expect(node).toMatchObject({ tagClass: 'context', tagNumber: 2, isConstructed: false });
    expect(new TextDecoder().decode(node.content)).toBe('abc');
  });

  it('decodes the high-tag-number form', () => {
    const node = decodeDer(der('BF 1F 03 02 01 05'));
    expect(node).toMatchObject({ tagClass: 'context', tagNumber: 31, isConstructed: true });
  });

  /** Views, not copies. */
  it('returns views into the input, never copies', () => {
    const input = der('30 03 02 01 05');
    const node = decodeDer(input);
    if (!node.isConstructed) throw new Error('expected a constructed node');
    expect(node.bytes.buffer).toBe(input.buffer);
    expect(node.children[0]?.bytes.buffer).toBe(input.buffer);
  });
});

describe('length encoding', () => {
  rejects([
    {
      why: 'a header with no length octet',
      bytes: '30',
      code: 'truncated',
    },
    {
      why: 'content shorter than the length declares — slice() would clamp and call it success',
      bytes: '04 05 01 02 03',
      code: 'truncated',
    },
    {
      why: "BER's indefinite length, which decodes as an empty value if unchecked",
      bytes: '30 80 02 01 05 00 00',
      code: 'indefinite-length',
    },
    {
      why: '0xFF, reserved by X.690 s8.1.3.5(c)',
      bytes: '30 FF',
      code: 'reserved-length',
    },
    {
      why: 'long form for a length under 128',
      bytes: '02 81 01 05',
      code: 'non-minimal-length',
    },
    {
      why: 'a leading zero octet in a long-form length',
      bytes: '04 82 00 05 01 02 03 04 05',
      code: 'non-minimal-length',
    },
    {
      why: 'more length octets than a safe integer holds',
      bytes: '04 85 01 00 00 00 00',
      code: 'length-too-large',
    },
  ]);
});

describe('tag encoding', () => {
  rejects([
    {
      why: 'the high-tag-number form for a tag under 31',
      bytes: 'BF 05 00',
      code: 'non-minimal-tag',
    },
    {
      why: 'a leading 0x80 in a base-128 tag number',
      bytes: 'BF 80 1F 03 02 01 05',
      code: 'non-minimal-tag',
    },
    {
      why: 'a universal tag outside the X.509 type universe (REAL)',
      bytes: '09 01 00',
      code: 'unsupported-universal-tag',
    },
  ]);
});

describe('primitive versus constructed', () => {
  rejects([
    {
      why: "a constructed OCTET STRING — BER's segmented form",
      bytes: '24 03 04 01 41',
      code: 'wrong-form',
    },
    {
      why: 'a primitive SEQUENCE',
      bytes: '10 00',
      code: 'wrong-form',
    },
  ]);
});

describe('structure', () => {
  rejects([
    {
      why: 'bytes after the one top-level TLV',
      bytes: '05 00 00',
      code: 'trailing-data',
    },
    /** A child declaring more than its parent holds: overshoot is truncation. */
    {
      why: 'a child declaring more content than its parent holds',
      bytes: '30 03 02 02 05',
      code: 'truncated',
    },
    {
      why: 'a partial TLV left over inside a parent, which is the same rule seen from the other side',
      bytes: '30 04 02 01 05 00',
      code: 'truncated',
    },
  ]);

  /** Brackets the bound without pinning it. */
  const nest = (depth: number): Uint8Array =>
    Array.from({ length: depth }).reduce<Uint8Array>(inner => tlv(0x30, inner), der('05 00'));

  it('accepts nesting a certificate could plausibly reach', () => {
    expect(decodeDer(nest(20)).tagNumber).toBe(16);
  });

  it('rejects runaway nesting as our own error, not a stack overflow', () => {
    expect(rejectionOf(() => decodeDer(nest(40))).code).toBe('depth-exceeded');
  });
});

describe('decodeBoolean', () => {
  it('reads the two encodings DER admits', () => {
    expect(decodeBoolean(decodeDer(der('01 01 FF')))).toBe(true);
    expect(decodeBoolean(decodeDer(der('01 01 00')))).toBe(false);
  });

  it("rejects BER's other truthy octets — DER's true is 0xFF alone", () => {
    expect(rejectionOf(() => decodeBoolean(decodeDer(der('01 01 01')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects a BOOLEAN that is not exactly one octet', () => {
    expect(rejectionOf(() => decodeBoolean(decodeDer(der('01 02 00 FF')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects a node of the wrong type', () => {
    expect(rejectionOf(() => decodeBoolean(decodeDer(der('02 01 05')))).code).toBe(
      'unexpected-tag',
    );
  });
});

describe('decodeInteger', () => {
  it('reads two’s complement', () => {
    expect(decodeInteger(decodeDer(der('02 01 05')))).toBe(5n);
    expect(decodeInteger(decodeDer(der('02 01 00')))).toBe(0n);
    expect(decodeInteger(decodeDer(der('02 01 80')))).toBe(-128n);
  });

  it('keeps the leading zero that a positive high bit REQUIRES', () => {
    expect(decodeInteger(decodeDer(der('02 02 00 80')))).toBe(128n);
  });

  it('reads a 20-octet serial number, which is why this returns bigint', () => {
    expect(decodeInteger(decodeDer(der('02 14 7F' + 'FF'.repeat(19))))).toBe((1n << 159n) - 1n);
  });

  it('rejects an empty INTEGER', () => {
    expect(rejectionOf(() => decodeInteger(decodeDer(der('02 00')))).code).toBe('malformed-value');
  });

  it('rejects a leading zero that buys nothing', () => {
    expect(rejectionOf(() => decodeInteger(decodeDer(der('02 02 00 05')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects redundant sign extension on a negative', () => {
    expect(rejectionOf(() => decodeInteger(decodeDer(der('02 02 FF 80')))).code).toBe(
      'malformed-value',
    );
  });
});

describe('decodeOid', () => {
  it('reads commonName', () => {
    expect(decodeOid(decodeDer(der('06 03 55 04 03')))).toBe('2.5.4.3');
  });

  it('reads a multi-octet arc: sha256WithRSAEncryption', () => {
    expect(decodeOid(decodeDer(der('06 09 2A 86 48 86 F7 0D 01 01 0B')))).toBe(
      '1.2.840.113549.1.1.11',
    );
  });

  /** Arc 1 is only ever 0, 1 or 2, so above 119 the second arc keeps growing. */
  it('reads a first octet above 119 without inventing an arc 3', () => {
    expect(decodeOid(decodeDer(der('06 01 7F')))).toBe('2.47');
  });

  it('reads the lowest first octet', () => {
    expect(decodeOid(decodeDer(der('06 01 28')))).toBe('1.0');
  });

  it('rejects an empty OID', () => {
    expect(rejectionOf(() => decodeOid(decodeDer(der('06 00')))).code).toBe('malformed-value');
  });

  it('rejects an arc whose continuation bit never terminates', () => {
    expect(rejectionOf(() => decodeOid(decodeDer(der('06 01 80')))).code).toBe('malformed-value');
  });

  it('rejects a leading 0x80, which pads a base-128 arc', () => {
    expect(rejectionOf(() => decodeOid(decodeDer(der('06 02 80 01')))).code).toBe(
      'malformed-value',
    );
  });
});

describe('decodeBitString', () => {
  it('reads octet-aligned bits', () => {
    const { bytes, unusedBits } = decodeBitString(decodeDer(der('03 04 00 01 02 03')));
    expect(unusedBits).toBe(0);
    expect([...bytes]).toEqual([0x01, 0x02, 0x03]);
  });

  it('reads a partial final octet whose unused bits are zero', () => {
    expect(decodeBitString(decodeDer(der('03 02 01 FE'))).unusedBits).toBe(1);
  });

  it('rejects a BIT STRING with no unused-bits octet at all', () => {
    expect(rejectionOf(() => decodeBitString(decodeDer(der('03 00')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects more than seven unused bits', () => {
    expect(rejectionOf(() => decodeBitString(decodeDer(der('03 02 08 00')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects unused bits declared over no content', () => {
    expect(rejectionOf(() => decodeBitString(decodeDer(der('03 01 03')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects unused bits that are not zero, which DER requires', () => {
    expect(rejectionOf(() => decodeBitString(decodeDer(der('03 02 01 FF')))).code).toBe(
      'malformed-value',
    );
  });
});

describe('decodeTime', () => {
  const utc = (text: string): Uint8Array => tlv(0x17, ascii(text));
  const generalized = (text: string): Uint8Array => tlv(0x18, ascii(text));

  it('reads UTCTime, with the RFC 5280 pivot at 50', () => {
    expect(decodeTime(decodeDer(utc('991231235959Z'))).toISOString()).toBe(
      '1999-12-31T23:59:59.000Z',
    );
    expect(decodeTime(decodeDer(utc('240101000000Z'))).toISOString()).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  it('reads GeneralizedTime', () => {
    expect(decodeTime(decodeDer(generalized('20240101000000Z'))).toISOString()).toBe(
      '2024-01-01T00:00:00.000Z',
    );
  });

  /** `new Date('2024-02-30T00:00:00Z')` returns March 1st. */
  it('rejects a day-of-month that does not exist, rather than rolling it forward', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(utc('240230235959Z')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects omitted seconds, which RFC 5280 s4.1.2.5.1 forbids', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(utc('9912312359Z')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects a UTC offset, since RFC 5280 demands Z', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(utc('991231235959+0000')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects fractional seconds in a GeneralizedTime', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(generalized('20240101000000.5Z')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects a leap second', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(utc('991231235960Z')))).code).toBe(
      'malformed-value',
    );
  });

  it('rejects a node of the wrong type', () => {
    expect(rejectionOf(() => decodeTime(decodeDer(der('02 01 05')))).code).toBe('unexpected-tag');
  });
});
