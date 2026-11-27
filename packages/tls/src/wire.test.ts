import { CERTIFICATE_CURVE_OIDS, CERTIFICATE_SIGNATURE_ALGORITHM_OIDS } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES } from '../vectors/rfc8448.ts';
import { decodeHandshakeMessage, encodeProductionClientHello } from './handshake-messages.ts';
import { CIPHER_SUITES } from './key-schedule.ts';
import { generateKeyShare } from './key-share.ts';
import {
  ALERT_DESCRIPTIONS,
  CERTIFICATE_SIGNATURE_SCHEMES,
  EXTENSION_TYPES,
  HANDSHAKE_TYPES,
  HRR_MAGIC_RANDOM,
  NAMED_GROUPS,
  namedGroupFromCode,
  OFFERED_CERTIFICATE_SIGNATURE_SCHEMES,
  SIGNATURE_SCHEMES,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  SUPPORTED_TLS_1_2_CIPHER_SUITES,
  SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES,
  signatureSchemeFromCode,
  TLS_1_2_CIPHER_SUITES,
  TLS_1_2_SIGNATURE_SCHEMES,
  tls12SignatureSchemeFromCode,
  tls12SuiteFromCode,
} from './wire.ts';

describe('Stage 1 — Wire tables', () => {
  it('exposes the two offered cipher-suite code points', () => {
    expect(CIPHER_SUITES.TLS_AES_128_GCM_SHA256.code).toBe(0x1301);
    expect(CIPHER_SUITES.TLS_AES_256_GCM_SHA384.code).toBe(0x1302);
  });

  it('exposes the three offered named-group code points', () => {
    expect(NAMED_GROUPS.x25519).toBe(0x001d);
    expect(NAMED_GROUPS.secp256r1).toBe(0x0017);
    expect(NAMED_GROUPS.secp384r1).toBe(0x0018);
  });

  it('SUPPORTED_GROUPS covers every group in NAMED_GROUPS', () => {
    // `namedGroupFromCode` searches SUPPORTED_GROUPS, so an implemented group left out of it
    // would make a legitimate HelloRetryRequest look like a request for an unknown curve.
    expect([...SUPPORTED_GROUPS].toSorted()).toEqual(Object.keys(NAMED_GROUPS).toSorted());
  });

  it('maps every offered group code back to its name, and nothing else', () => {
    for (const name of SUPPORTED_GROUPS) {
      expect(namedGroupFromCode(NAMED_GROUPS[name])).toBe(name);
    }
    // 0x0019 is secp521r1, not implemented.
    expect(namedGroupFromCode(0x0019)).toBeUndefined();
  });

  it('SUPPORTED_SIGNATURE_SCHEMES covers every scheme in SIGNATURE_SCHEMES', () => {
    // The list is what `signature_algorithms` offers and what a CertificateVerify may use;
    // `verify.test.ts` checks that a listed scheme is implemented.
    expect([...SUPPORTED_SIGNATURE_SCHEMES].toSorted()).toEqual(
      Object.keys(SIGNATURE_SCHEMES).toSorted(),
    );
  });

  it('maps every offered scheme code back to its name, and nothing else', () => {
    for (const name of SUPPORTED_SIGNATURE_SCHEMES) {
      expect(signatureSchemeFromCode(SIGNATURE_SCHEMES[name])).toBe(name);
    }
    // 0x0401 is rsa_pkcs1_sha256, forbidden in CertificateVerify; 0x0603 is ecdsa_secp521r1_sha512,
    // in CERTIFICATE_SIGNATURE_SCHEMES only.
    expect(signatureSchemeFromCode(0x0401)).toBeUndefined();
    expect(signatureSchemeFromCode(0x0603)).toBeUndefined();
  });

  it('HRR magic equals the published §5 HelloRetryRequest random', () => {
    const trace5 = RFC_8448_TRACES.find(t => t.section === '5');
    expect(trace5).toBeDefined();

    // §5's first constructed ServerHello is the HRR (same type; magic random).
    const hrrStep = trace5!.steps.find(
      s => s.actor === 'server' && s.title.includes('construct a ServerHello'),
    );
    expect(hrrStep).toBeDefined();
    const hrrBytes = hrrStep!.fields.find(f => f.label === 'ServerHello')?.bytes;
    expect(hrrBytes).toBeDefined();

    const decoded = decodeHandshakeMessage(hrrBytes!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value.kind !== 'server_hello') return;

    expect(decoded.value.random).toEqual(HRR_MAGIC_RANDOM);
    expect(HRR_MAGIC_RANDOM[0]).toBe(0xcf);
    expect(HRR_MAGIC_RANDOM[31]).toBe(0x9c);
  });
});

/**
 * `@yozz.app/x509` decides which certificate signatures are verifiable and hands that over as
 * OIDs; the mapping here is what drifts. RFC 9846 §4.5.1.2 tells a server that can match our
 * list to prefer it, so advertising what the validator refuses breaks the handshake ourselves.
 * See DECISIONS.md, "`signature_algorithms_cert` is derived from `@yozz.app/x509`".
 */
describe('signature_algorithms_cert agrees with what @yozz.app/x509 verifies', () => {
  const offered = OFFERED_CERTIFICATE_SIGNATURE_SCHEMES.map(
    name => CERTIFICATE_SIGNATURE_SCHEMES[name],
  );

  it('advertises no algorithm the validator would refuse', () => {
    for (const scheme of offered) {
      expect(CERTIFICATE_SIGNATURE_ALGORITHM_OIDS).toContain(scheme.algorithmOid);
    }
  });

  it('advertises no curve the validator would refuse', () => {
    for (const { curveOid } of offered) {
      if (curveOid !== null) expect(CERTIFICATE_CURVE_OIDS).toContain(curveOid);
    }
  });

  /** The other direction: an OID x509 learns must get a code point here, or a written reason for none. */
  it('leaves no algorithm the validator accepts unadvertised', () => {
    const advertised = new Set(offered.map(scheme => scheme.algorithmOid));
    expect([...CERTIFICATE_SIGNATURE_ALGORITHM_OIDS].sort()).toEqual([...advertised].sort());
  });

  /** The same ECDSA scheme signs both messages, so it must carry one code point in both tables. */
  it('gives the shared ECDSA names one code point, not two', () => {
    for (const name of ['ecdsa_secp256r1_sha256', 'ecdsa_secp384r1_sha384'] as const) {
      expect(CERTIFICATE_SIGNATURE_SCHEMES[name].code).toBe(SIGNATURE_SCHEMES[name]);
    }
  });

  /** The defect as a regression: RSA-PKCS1 was never advertised, RSA-PSS and Ed25519 were and are not verifiable in a chain. */
  /**
   * Literals, not a derivation: the OID checks never read `.code` and the name checks read
   * `Object.keys`, so `rsa_pkcs1_sha256` given `0x0804` passed everything else. IANA's TLS
   * SignatureScheme registry values, also listed in RFC 9846 §4.3.3.
   */
  it('carries the IANA code point for every scheme it advertises', () => {
    expect(
      Object.fromEntries(
        Object.entries(CERTIFICATE_SIGNATURE_SCHEMES).map(([name, { code }]) => [name, code]),
      ),
    ).toEqual({
      rsa_pkcs1_sha256: 0x0401,
      rsa_pkcs1_sha384: 0x0501,
      rsa_pkcs1_sha512: 0x0601,
      ecdsa_secp256r1_sha256: 0x0403,
      ecdsa_secp384r1_sha384: 0x0503,
      ecdsa_secp521r1_sha512: 0x0603,
    });
  });

  /** Read back off a real ClientHello: the only assertion connecting the table to the bytes. */
  it('puts them on a production ClientHello, in order', async () => {
    const share = await generateKeyShare('x25519');
    const decoded = decodeHandshakeMessage(
      encodeProductionClientHello({
        serverName: 'mail.example.com',
        keySharePublicKey: share.publicKey,
        group: 'x25519',
      }),
    );
    if (!decoded.ok || decoded.value.kind !== 'client_hello') {
      throw new Error('our own ClientHello does not decode');
    }
    const sent = decoded.value.extensions.find(
      extension => extension.kind === 'signature_algorithms_cert',
    );
    expect(sent).toEqual({
      kind: 'signature_algorithms_cert',
      schemes: OFFERED_CERTIFICATE_SIGNATURE_SCHEMES.map(
        name => CERTIFICATE_SIGNATURE_SCHEMES[name].code,
      ),
    });

    // A second list, not a replacement (§4.3.3).
    expect(
      decoded.value.extensions.some(extension => extension.kind === 'signature_algorithms'),
    ).toBe(true);
  });

  it('carries RSA-PKCS1 and does not carry RSA-PSS or Ed25519', () => {
    expect(OFFERED_CERTIFICATE_SIGNATURE_SCHEMES).toContain('rsa_pkcs1_sha256');
    expect(Object.keys(CERTIFICATE_SIGNATURE_SCHEMES)).not.toContain('rsa_pss_rsae_sha256');
    expect(Object.keys(CERTIFICATE_SIGNATURE_SCHEMES)).not.toContain('ed25519');
  });
});

describe('TLS 1.2 wire tables', () => {
  /** Literals, IANA's TLS Cipher Suites registry (RFC 5289 §3). */
  it('carries the IANA code point and parameters for every TLS 1.2 suite', () => {
    expect(TLS_1_2_CIPHER_SUITES).toEqual({
      TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256: {
        code: 0xc02b,
        hash: 'SHA-256',
        hashLength: 32,
        keyLength: 16,
        implicitIvLength: 4,
        explicitNonceLength: 8,
        auth: 'ecdsa',
      },
      TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256: {
        code: 0xc02f,
        hash: 'SHA-256',
        hashLength: 32,
        keyLength: 16,
        implicitIvLength: 4,
        explicitNonceLength: 8,
        auth: 'rsa',
      },
      TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384: {
        code: 0xc02c,
        hash: 'SHA-384',
        hashLength: 48,
        keyLength: 32,
        implicitIvLength: 4,
        explicitNonceLength: 8,
        auth: 'ecdsa',
      },
      TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384: {
        code: 0xc030,
        hash: 'SHA-384',
        hashLength: 48,
        keyLength: 32,
        implicitIvLength: 4,
        explicitNonceLength: 8,
        auth: 'rsa',
      },
    });
  });

  it('offers every TLS 1.2 suite, AES-128 first', () => {
    expect(SUPPORTED_TLS_1_2_CIPHER_SUITES.map(name => TLS_1_2_CIPHER_SUITES[name].code)).toEqual([
      0xc02b, 0xc02f, 0xc02c, 0xc030,
    ]);
  });

  it('maps every TLS 1.2 suite code back to its name, and nothing else', () => {
    for (const name of SUPPORTED_TLS_1_2_CIPHER_SUITES) {
      expect(tls12SuiteFromCode(TLS_1_2_CIPHER_SUITES[name].code)).toBe(name);
    }
    // TLS 1.3 suites, CBC (0xc023) and RSA key exchange GCM (0x009c) are not TLS 1.2 suites we run.
    for (const code of [0x1301, 0x1302, 0xc023, 0x009c, 0xcca8]) {
      expect(tls12SuiteFromCode(code)).toBeUndefined();
    }
  });

  it('carries the IANA code point for every TLS 1.2 signature scheme', () => {
    expect(TLS_1_2_SIGNATURE_SCHEMES).toEqual({
      ecdsa_secp256r1_sha256: 0x0403,
      ecdsa_secp384r1_sha384: 0x0503,
      rsa_pss_rsae_sha256: 0x0804,
      rsa_pss_rsae_sha384: 0x0805,
      rsa_pss_rsae_sha512: 0x0806,
      ed25519: 0x0807,
      rsa_pkcs1_sha256: 0x0401,
      rsa_pkcs1_sha384: 0x0501,
      rsa_pkcs1_sha512: 0x0601,
    });
  });

  it('offers the TLS 1.3 schemes first and RSA-PKCS1 last', () => {
    expect(SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES).toEqual([
      ...SUPPORTED_SIGNATURE_SCHEMES,
      'rsa_pkcs1_sha256',
      'rsa_pkcs1_sha384',
      'rsa_pkcs1_sha512',
    ]);
  });

  it('maps every TLS 1.2 scheme code back to its name, and nothing else', () => {
    for (const name of SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES) {
      expect(tls12SignatureSchemeFromCode(TLS_1_2_SIGNATURE_SCHEMES[name])).toBe(name);
    }
    // SHA-1 (0x0201, 0x0203) and P-521 (0x0603) are refused.
    for (const code of [0x0201, 0x0203, 0x0603]) {
      expect(tls12SignatureSchemeFromCode(code)).toBeUndefined();
    }
  });

  /** The separation the TLS 1.2 table must not erode (RFC 9846 §4.5.2). */
  it('leaves RSA-PKCS1 out of the TLS 1.3 table', () => {
    expect(tls12SignatureSchemeFromCode(0x0401)).toBe('rsa_pkcs1_sha256');
    expect(signatureSchemeFromCode(0x0401)).toBeUndefined();
    expect(Object.keys(SIGNATURE_SCHEMES)).not.toContain('rsa_pkcs1_sha256');
    expect(SUPPORTED_SIGNATURE_SCHEMES).not.toContain('rsa_pkcs1_sha256');
  });

  it('carries the TLS 1.2 handshake, extension and alert code points', () => {
    expect(HANDSHAKE_TYPES).toMatchObject({
      hello_request: 0,
      server_key_exchange: 12,
      server_hello_done: 14,
      client_key_exchange: 16,
    });
    expect(EXTENSION_TYPES).toMatchObject({
      ec_point_formats: 11,
      extended_master_secret: 23,
      renegotiation_info: 0xff01,
    });
    expect(ALERT_DESCRIPTIONS.no_renegotiation).toBe(100);
  });

  it('gives no two handshake types, extensions or alerts the same code', () => {
    for (const table of [HANDSHAKE_TYPES, EXTENSION_TYPES, ALERT_DESCRIPTIONS]) {
      const codes = Object.values(table);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });
});
