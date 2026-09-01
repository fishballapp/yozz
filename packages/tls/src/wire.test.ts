import { CERTIFICATE_CURVE_OIDS, CERTIFICATE_SIGNATURE_ALGORITHM_OIDS } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES } from '../vectors/rfc8448.ts';
import { decodeHandshakeMessage, encodeProductionClientHello } from './handshake-messages.ts';
import { CIPHER_SUITES } from './key-schedule.ts';
import { generateKeyShare } from './key-share.ts';
import {
  CERTIFICATE_SIGNATURE_SCHEMES,
  HRR_MAGIC_RANDOM,
  NAMED_GROUPS,
  namedGroupFromCode,
  OFFERED_CERTIFICATE_SIGNATURE_SCHEMES,
  SIGNATURE_SCHEMES,
  SUPPORTED_GROUPS,
  SUPPORTED_SIGNATURE_SCHEMES,
  signatureSchemeFromCode,
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
