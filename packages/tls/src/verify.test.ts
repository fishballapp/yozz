import { decodeCertificate } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { concat } from './bytes.ts';
import { decodeHandshakeMessage } from './handshake-messages.ts';
import { Transcript } from './transcript.ts';
import { importLeafKey, verifyCertificateVerify, verifyServerKeyExchange } from './verify.ts';
import {
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  SUPPORTED_SIGNATURE_SCHEMES,
  SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES,
  TLS_1_2_SIGNATURE_SCHEMES,
  type Tls12SignatureScheme,
} from './wire.ts';

const rsaParams = (hash: string): RsaHashedKeyGenParams => ({
  name: 'RSA-PSS',
  modulusLength: 2048,
  publicExponent: Uint8Array.of(1, 0, 1),
  hash,
});

/** §4.3.3: the salt is the digest's own output length. */
const pssParams = (saltLength: number): RsaPssParams => ({ name: 'RSA-PSS', saltLength });

/** A minimally-encoded DER INTEGER: no leading zeros, and 0x00 when bit 7 is set. */
const derInteger = (bytes: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const body = bytes.subarray(start);
  const first = body[0];
  if (first === undefined) throw new Error('empty ECDSA scalar');
  const padded = first >= 0x80 ? concat(Uint8Array.of(0), body) : body;
  return concat(Uint8Array.of(0x02, padded.length), padded);
};

/** WebCrypto signs ECDSA to fixed-width `r || s`; a CertificateVerify carries DER. */
const derFromP1363 = (signature: Uint8Array): Uint8Array => {
  const half = signature.length / 2;
  const body = concat(
    derInteger(signature.subarray(0, half)),
    derInteger(signature.subarray(half)),
  );
  return concat(Uint8Array.of(0x30, body.length), body);
};

const SUITE = 'TLS_AES_128_GCM_SHA256' as const;

type TraceVerifyContext = {
  readonly section: string;
  readonly leafDer: Uint8Array;
  readonly spkiDer: Uint8Array;
  readonly cvScheme: number;
  readonly cvSignature: Uint8Array;
  readonly transcriptHash: Uint8Array;
};

const extractServerVerifyContext = async (
  trace: Rfc8448Trace,
): Promise<TraceVerifyContext | null> => {
  const transcript = new Transcript(SUITE);
  let hasSeenHrr = false;
  let leafDer: Uint8Array | undefined;
  let spkiDer: Uint8Array | undefined;
  let cvScheme: number | undefined;
  let cvSignature: Uint8Array | undefined;
  let transcriptHashAtCert: Uint8Array | undefined;

  for (const step of trace.steps) {
    if (/^construct an? .+ handshake message/.test(step.title)) {
      for (const field of step.fields) {
        if (field.label === 'ServerHello' && trace.section === '5' && !hasSeenHrr) {
          await transcript.replaceClientHello1WithMessageHash();
          hasSeenHrr = true;
        }

        const decoded = decodeHandshakeMessage(field.bytes);
        if (decoded.ok) {
          if (
            decoded.value.kind === 'certificate' &&
            step.actor === 'server' &&
            leafDer === undefined
          ) {
            const firstEntry = decoded.value.certificateList[0];
            if (firstEntry !== undefined) {
              leafDer = firstEntry.certData;
              const cert = decodeCertificate(leafDer);
              spkiDer = cert.subjectPublicKeyInfo.der;
            }
            transcript.add(field.bytes);
            transcriptHashAtCert = await transcript.hash();
            continue;
          }

          if (decoded.value.kind === 'certificate_verify' && step.actor === 'server') {
            cvScheme = decoded.value.scheme;
            cvSignature = decoded.value.signature;
          }
        }

        transcript.add(field.bytes);
      }
    }
  }

  if (
    leafDer === undefined ||
    spkiDer === undefined ||
    cvScheme === undefined ||
    cvSignature === undefined ||
    transcriptHashAtCert === undefined
  ) {
    return null;
  }

  return {
    section: trace.section,
    leafDer,
    spkiDer,
    cvScheme,
    cvSignature,
    transcriptHash: transcriptHashAtCert,
  };
};

describe('Stage 6: CertificateVerify & leaf key import against RFC 8448', () => {
  for (const section of ['3', '5', '6', '7']) {
    it(`§${section} server CertificateVerify verifies against leaf SPKI and transcript`, async () => {
      const trace = RFC_8448_TRACES.find(t => t.section === section);
      expect(trace).toBeDefined();

      const ctx = await extractServerVerifyContext(trace!);
      expect(ctx).not.toBeNull();
      if (ctx === null) return;

      if (section === '6') {
        expect(ctx.cvScheme).toBe(0x0403); // ecdsa_secp256r1_sha256
      } else {
        expect(ctx.cvScheme).toBe(0x0804); // rsa_pss_rsae_sha256
      }

      const result = await verifyCertificateVerify({
        scheme: ctx.cvScheme,
        signature: ctx.cvSignature,
        spkiDer: ctx.spkiDer,
        transcriptHash: ctx.transcriptHash,
      });

      expect(result).toEqual({ ok: true });
    });
  }

  it('rejects tampered signature with decrypt_error', async () => {
    const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
    const ctx = (await extractServerVerifyContext(trace3))!;

    const tamperedSig = new Uint8Array(ctx.cvSignature);
    tamperedSig[0]! ^= 0x01;

    const result = await verifyCertificateVerify({
      scheme: ctx.cvScheme,
      signature: tamperedSig,
      spkiDer: ctx.spkiDer,
      transcriptHash: ctx.transcriptHash,
    });

    expect(result).toEqual({ ok: false, description: 'decrypt_error' });
  });

  it('rejects tampered transcript hash with decrypt_error', async () => {
    const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
    const ctx = (await extractServerVerifyContext(trace3))!;

    const tamperedHash = new Uint8Array(ctx.transcriptHash);
    tamperedHash[0]! ^= 0x01;

    const result = await verifyCertificateVerify({
      scheme: ctx.cvScheme,
      signature: ctx.cvSignature,
      spkiDer: ctx.spkiDer,
      transcriptHash: tamperedHash,
    });

    expect(result).toEqual({ ok: false, description: 'decrypt_error' });
  });

  it('fails with illegal_parameter when scheme does not match SPKI algorithm family', async () => {
    const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
    const ctx = (await extractServerVerifyContext(trace3))!;

    // §3's SPKI is RSA (1.2.840.113549.1.1.1).
    const rsaRes = await importLeafKey(ctx.spkiDer, 0x0804);
    expect(rsaRes.ok).toBe(true);

    const ecdsaRes = await importLeafKey(ctx.spkiDer, 0x0403);
    expect(ecdsaRes).toEqual({ ok: false, description: 'illegal_parameter' });
  });

  it('refuses an id-RSASSA-PSS key for an rsa_pss_RSAE scheme', async () => {
    // RFC 9846 §4.3.3: rsa_pss_rsae_* is "public key OID rsaEncryption"; an id-RSASSA-PSS key
    // belongs to rsa_pss_pss_*, which this client does not offer.
    const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
    const ctx = (await extractServerVerifyContext(trace3))!;

    // The two OIDs encode to the same length and differ only in the last byte.
    const rsaEncryption = Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
    const start = ctx.spkiDer.findIndex((_, index) =>
      rsaEncryption.every((byte, offset) => ctx.spkiDer[index + offset] === byte),
    );
    expect(start).toBeGreaterThan(0);
    const pssKey = new Uint8Array(ctx.spkiDer);
    pssKey[start + rsaEncryption.length - 1] = 0x0a;

    expect(await importLeafKey(pssKey, 0x0804)).toEqual({
      ok: false,
      description: 'illegal_parameter',
    });
  });

  it('refuses a P-256 key for ecdsa_secp384r1_sha384', async () => {
    // §4.5.2: the scheme "MUST be compatible with the key", and an ECDSA scheme names its curve.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));

    expect(await importLeafKey(spki, 0x0403)).toMatchObject({ ok: true });
    expect(await importLeafKey(spki, 0x0503)).toEqual({
      ok: false,
      description: 'illegal_parameter',
    });
  });

  /**
   * A scheme in the `SignatureScheme` union without a case in `importLeafKey` falls through to
   * `illegal_parameter`. The key-per-scheme table is a second statement of what each scheme
   * means: `Record<SignatureScheme, …>` makes an unlisted scheme a compile error.
   */
  it('every scheme the client offers is one importLeafKey can import', async () => {
    const spkiOf = async (key: CryptoKey): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.exportKey('spki', key));

    // WebCrypto exports an RSA-PSS public key under the rsaEncryption OID, as §4.3.3 requires of `rsa_pss_rsae_*`.
    const rsa = async (hash: string): Promise<Uint8Array> => {
      const pair = await crypto.subtle.generateKey(
        { name: 'RSA-PSS', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash },
        true,
        ['sign', 'verify'],
      );
      return spkiOf(pair.publicKey);
    };
    const ecdsa = async (namedCurve: string): Promise<Uint8Array> => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, [
        'sign',
        'verify',
      ]);
      return spkiOf(pair.publicKey);
    };

    const keyFor: Readonly<Record<SignatureScheme, () => Promise<Uint8Array>>> = {
      ecdsa_secp256r1_sha256: () => ecdsa('P-256'),
      ecdsa_secp384r1_sha384: () => ecdsa('P-384'),
      rsa_pss_rsae_sha256: () => rsa('SHA-256'),
      rsa_pss_rsae_sha384: () => rsa('SHA-384'),
      rsa_pss_rsae_sha512: () => rsa('SHA-512'),
      ed25519: async () => {
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        return spkiOf(pair.publicKey);
      },
    };

    for (const name of SUPPORTED_SIGNATURE_SCHEMES) {
      const spki = await keyFor[name]();
      expect(await importLeafKey(spki, SIGNATURE_SCHEMES[name]), name).toMatchObject({ ok: true });
    }
  });

  /**
   * RFC 8448 exercises `rsa_pss_rsae_sha256` only; §4.3.3 fixes the salt at the digest's output
   * length, and a salt off by 16 bytes is invisible to everything else in `pnpm test`.
   */
  it('verifies a real signature under every scheme the client offers', async () => {
    const transcript = crypto.getRandomValues(new Uint8Array(32));
    const signedData = concat(
      new Uint8Array(64).fill(0x20),
      new TextEncoder().encode('TLS 1.3, server CertificateVerify'),
      Uint8Array.of(0x00),
      transcript,
    );

    const signerFor: Readonly<
      Record<SignatureScheme, { readonly generate: Algorithm; readonly sign: AlgorithmIdentifier }>
    > = {
      ecdsa_secp256r1_sha256: {
        generate: { name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams,
        sign: { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams,
      },
      ecdsa_secp384r1_sha384: {
        generate: { name: 'ECDSA', namedCurve: 'P-384' } as EcKeyGenParams,
        sign: { name: 'ECDSA', hash: 'SHA-384' } as EcdsaParams,
      },
      rsa_pss_rsae_sha256: { generate: rsaParams('SHA-256'), sign: pssParams(32) },
      rsa_pss_rsae_sha384: { generate: rsaParams('SHA-384'), sign: pssParams(48) },
      rsa_pss_rsae_sha512: { generate: rsaParams('SHA-512'), sign: pssParams(64) },
      ed25519: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
    };

    for (const name of SUPPORTED_SIGNATURE_SCHEMES) {
      const { generate, sign } = signerFor[name];
      const pair = await crypto.subtle.generateKey(generate, true, ['sign', 'verify']);
      if (!('privateKey' in pair)) throw new Error(`${name} did not generate a key pair`);
      const raw = new Uint8Array(await crypto.subtle.sign(sign, pair.privateKey, signedData));
      // ECDSA signs to fixed-width r||s; a CertificateVerify carries DER.
      const signature = name.startsWith('ecdsa_') ? derFromP1363(raw) : raw;

      expect(
        await verifyCertificateVerify({
          scheme: SIGNATURE_SCHEMES[name],
          signature,
          spkiDer: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
          transcriptHash: transcript,
        }),
        name,
      ).toEqual({ ok: true });
    }
  });
});

type Signer = { readonly generate: Algorithm; readonly sign: AlgorithmIdentifier };

const ecdsaSigner = (namedCurve: string, hash: string): Signer => ({
  generate: { name: 'ECDSA', namedCurve } as EcKeyGenParams,
  sign: { name: 'ECDSA', hash } as EcdsaParams,
});

const pkcs1Signer = (hash: string): Signer => ({
  generate: { ...rsaParams(hash), name: 'RSASSA-PKCS1-v1_5' },
  sign: { name: 'RSASSA-PKCS1-v1_5' },
});

/** Under TLS 1.2 the ECDSA codes name the hash; the key here sits on the curve the name suggests. */
const TLS_1_2_SIGNERS: Readonly<Record<Tls12SignatureScheme, Signer>> = {
  ecdsa_secp256r1_sha256: ecdsaSigner('P-256', 'SHA-256'),
  ecdsa_secp384r1_sha384: ecdsaSigner('P-384', 'SHA-384'),
  rsa_pss_rsae_sha256: { generate: rsaParams('SHA-256'), sign: pssParams(32) },
  rsa_pss_rsae_sha384: { generate: rsaParams('SHA-384'), sign: pssParams(48) },
  rsa_pss_rsae_sha512: { generate: rsaParams('SHA-512'), sign: pssParams(64) },
  rsa_pkcs1_sha256: pkcs1Signer('SHA-256'),
  rsa_pkcs1_sha384: pkcs1Signer('SHA-384'),
  rsa_pkcs1_sha512: pkcs1Signer('SHA-512'),
  ed25519: { generate: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

type SignedServerKeyExchange = {
  readonly scheme: number;
  readonly signature: Uint8Array;
  readonly spkiDer: Uint8Array;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly serverParams: Uint8Array;
};

/** RFC 8422 §5.4: named_curve x25519, a 32-octet point. */
const serverParamsFixture = (): Uint8Array =>
  concat(Uint8Array.of(3, 0x00, 0x1d, 32), crypto.getRandomValues(new Uint8Array(32)));

const signServerKeyExchange = async (
  signer: Signer,
  scheme: number,
): Promise<SignedServerKeyExchange> => {
  const clientRandom = crypto.getRandomValues(new Uint8Array(32));
  const serverRandom = crypto.getRandomValues(new Uint8Array(32));
  const serverParams = serverParamsFixture();
  const pair = await crypto.subtle.generateKey(signer.generate, true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      signer.sign,
      pair.privateKey,
      concat(clientRandom, serverRandom, serverParams),
    ),
  );
  return {
    scheme,
    // ECDSA signs to fixed-width r||s; a ServerKeyExchange carries DER.
    signature: signer.generate.name === 'ECDSA' ? derFromP1363(raw) : raw,
    spkiDer: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    clientRandom,
    serverRandom,
    serverParams,
  };
};

const flipFirstBit = (bytes: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(bytes);
  copy[0]! ^= 0x01;
  return copy;
};

describe('verifyServerKeyExchange (TLS 1.2, RFC 5246 §7.4.3)', () => {
  it('verifies a real signature under every TLS 1.2 scheme the client offers', async () => {
    for (const name of SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES) {
      const signed = await signServerKeyExchange(
        TLS_1_2_SIGNERS[name],
        TLS_1_2_SIGNATURE_SCHEMES[name],
      );
      expect(await verifyServerKeyExchange(signed), name).toEqual({ ok: true });
    }
  });

  /** RFC 5246 §7.4.1.4.1: in TLS 1.2, 0x0403 is (SHA-256, ECDSA) on whatever curve the key is on. */
  it('verifies ECDSA with the scheme hash and the key curve, in both cross pairings', async () => {
    for (const [curve, hash, scheme] of [
      ['P-384', 'SHA-256', 0x0403],
      ['P-256', 'SHA-384', 0x0503],
    ] as const) {
      const signed = await signServerKeyExchange(ecdsaSigner(curve, hash), scheme);
      expect(await verifyServerKeyExchange(signed), `${curve} ${hash}`).toEqual({ ok: true });
      // The scheme's hash binds: the same signature under the other ECDSA code fails.
      expect(
        await verifyServerKeyExchange({ ...signed, scheme: scheme === 0x0403 ? 0x0503 : 0x0403 }),
      ).toEqual({ ok: false, description: 'decrypt_error' });
    }
  });

  it('refuses a P-521 key, which this client offers for no ECDHE signature', async () => {
    const signed = await signServerKeyExchange(ecdsaSigner('P-521', 'SHA-256'), 0x0403);
    expect(await verifyServerKeyExchange(signed)).toEqual({
      ok: false,
      description: 'illegal_parameter',
    });
  });

  it('refuses a scheme it never offers with illegal_parameter', async () => {
    const signed = await signServerKeyExchange(TLS_1_2_SIGNERS.rsa_pkcs1_sha256, 0x0401);
    // SHA-1 RSA, SHA-1 ECDSA, P-521 ECDSA, rsa_pss_pss_sha256, and nonsense.
    for (const scheme of [0x0201, 0x0203, 0x0603, 0x0809, 0xffff]) {
      expect(await verifyServerKeyExchange({ ...signed, scheme }), `0x${scheme}`).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
    }
  });

  it('refuses a key of the wrong type for the scheme with illegal_parameter', async () => {
    const rsa = await signServerKeyExchange(TLS_1_2_SIGNERS.rsa_pkcs1_sha256, 0x0401);
    const ecdsa = await signServerKeyExchange(TLS_1_2_SIGNERS.ecdsa_secp256r1_sha256, 0x0403);
    const ed25519 = await signServerKeyExchange(TLS_1_2_SIGNERS.ed25519, 0x0807);
    for (const [signed, scheme] of [
      [rsa, 0x0403],
      [rsa, 0x0807],
      [ecdsa, 0x0401],
      [ecdsa, 0x0804],
      [ecdsa, 0x0807],
      [ed25519, 0x0401],
      [ed25519, 0x0503],
    ] as const) {
      expect(await verifyServerKeyExchange({ ...signed, scheme })).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
    }
  });

  it('refuses a tampered random, server params or signature with decrypt_error', async () => {
    for (const name of [
      'rsa_pkcs1_sha256',
      'rsa_pss_rsae_sha256',
      'ecdsa_secp384r1_sha384',
      'ed25519',
    ] as const) {
      const signed = await signServerKeyExchange(
        TLS_1_2_SIGNERS[name],
        TLS_1_2_SIGNATURE_SCHEMES[name],
      );
      for (const tampered of [
        { ...signed, clientRandom: flipFirstBit(signed.clientRandom) },
        { ...signed, serverRandom: flipFirstBit(signed.serverRandom) },
        { ...signed, serverParams: flipFirstBit(signed.serverParams) },
        // The two randoms swapped: the order is part of what is signed.
        { ...signed, clientRandom: signed.serverRandom, serverRandom: signed.clientRandom },
        { ...signed, signature: flipFirstBit(signed.signature.slice().reverse()).reverse() },
      ]) {
        expect(await verifyServerKeyExchange(tampered), name).toEqual({
          ok: false,
          description: 'decrypt_error',
        });
      }
    }
  });

  it('refuses a malformed ECDSA DER signature with decrypt_error', async () => {
    const signed = await signServerKeyExchange(TLS_1_2_SIGNERS.ecdsa_secp256r1_sha256, 0x0403);
    // Negative, zero, and oversized (> 32-byte) scalars must be rejected rather than truncated.
    const zeroScalar = Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01);
    const negativeScalar = Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0xff, 0x02, 0x01, 0x01);
    const oversizedScalar = concat(
      Uint8Array.of(0x30, 38, 0x02, 33, 0x01),
      new Uint8Array(32).fill(0x22),
      Uint8Array.of(0x02, 0x01, 0x01),
    );
    for (const signature of [
      new Uint8Array(0),
      Uint8Array.of(0x30, 0x00),
      signed.signature.subarray(1),
      zeroScalar,
      negativeScalar,
      oversizedScalar,
    ]) {
      expect(await verifyServerKeyExchange({ ...signed, signature })).toEqual({
        ok: false,
        description: 'decrypt_error',
      });
    }
  });

  it('refuses an SPKI it cannot parse with bad_certificate', async () => {
    const signed = await signServerKeyExchange(TLS_1_2_SIGNERS.ed25519, 0x0807);
    expect(await verifyServerKeyExchange({ ...signed, spkiDer: Uint8Array.of(1, 2, 3) })).toEqual({
      ok: false,
      description: 'bad_certificate',
    });
  });
});

/** The TLS 1.2 relaxations must not reach TLS 1.3 (RFC 9846 §4.5.2). */
describe('verifyCertificateVerify stays TLS 1.3-strict', () => {
  const tls13SignedData = (transcriptHash: Uint8Array): Uint8Array<ArrayBuffer> =>
    concat(
      new Uint8Array(64).fill(0x20),
      new TextEncoder().encode('TLS 1.3, server CertificateVerify'),
      Uint8Array.of(0x00),
      transcriptHash,
    );

  it('refuses rsa_pkcs1_sha256/384/512 even over a valid signature', async () => {
    const transcriptHash = crypto.getRandomValues(new Uint8Array(32));
    for (const name of ['rsa_pkcs1_sha256', 'rsa_pkcs1_sha384', 'rsa_pkcs1_sha512'] as const) {
      const signer = TLS_1_2_SIGNERS[name];
      const pair = await crypto.subtle.generateKey(signer.generate, true, ['sign', 'verify']);
      if (!('privateKey' in pair)) throw new Error('no key pair');
      const signature = new Uint8Array(
        await crypto.subtle.sign(signer.sign, pair.privateKey, tls13SignedData(transcriptHash)),
      );
      const spkiDer = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
      const scheme = TLS_1_2_SIGNATURE_SCHEMES[name];

      expect(
        await verifyCertificateVerify({ scheme, signature, spkiDer, transcriptHash }),
        name,
      ).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
      expect(await importLeafKey(spkiDer, scheme), name).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
    }
  });

  it('still refuses a P-384 key under ecdsa_secp256r1_sha256', async () => {
    const transcriptHash = crypto.getRandomValues(new Uint8Array(32));
    const signer = ecdsaSigner('P-384', 'SHA-256');
    const pair = await crypto.subtle.generateKey(signer.generate, true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('no key pair');
    const raw = new Uint8Array(
      await crypto.subtle.sign(signer.sign, pair.privateKey, tls13SignedData(transcriptHash)),
    );
    expect(
      await verifyCertificateVerify({
        scheme: 0x0403,
        signature: derFromP1363(raw),
        spkiDer: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
        transcriptHash,
      }),
    ).toEqual({ ok: false, description: 'illegal_parameter' });
  });
});
