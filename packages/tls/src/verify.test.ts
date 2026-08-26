import { decodeCertificate } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { concat } from './bytes.ts';
import { decodeHandshakeMessage } from './handshake-messages.ts';
import { Transcript } from './transcript.ts';
import { importLeafKey, verifyCertificateVerify } from './verify.ts';
import { SIGNATURE_SCHEMES, type SignatureScheme, SUPPORTED_SIGNATURE_SCHEMES } from './wire.ts';

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

    // §3 SPKI is RSA (1.2.840.113549.1.1.1)
    // Importing with 0x0804 (RSA-PSS) succeeds:
    const rsaRes = await importLeafKey(ctx.spkiDer, 0x0804);
    expect(rsaRes.ok).toBe(true);

    // Importing with 0x0403 (ECDSA) fails with illegal_parameter:
    const ecdsaRes = await importLeafKey(ctx.spkiDer, 0x0403);
    expect(ecdsaRes).toEqual({ ok: false, description: 'illegal_parameter' });
  });

  it('refuses an id-RSASSA-PSS key for an rsa_pss_RSAE scheme', async () => {
    // RFC 9846 §4.3.3 names the two families apart: rsa_pss_rsae_* are
    // "RSASSA-PSS algorithms with public key OID rsaEncryption", and an
    // id-RSASSA-PSS key belongs to rsa_pss_pss_*, which this client does not
    // offer. Both OIDs were accepted here.
    const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
    const ctx = (await extractServerVerifyContext(trace3))!;

    // 1.2.840.113549.1.1.1 and .1.10 encode to the same length, so the only
    // difference between an rsaEncryption SPKI and an id-RSASSA-PSS one is the
    // last byte of the OID.
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
    // §4.5.2: "the signature algorithm MUST be compatible with the key in the
    // sender's end-entity certificate", and in TLS 1.3 an ECDSA scheme names
    // its curve. Left to WebCrypto's import throwing, the mismatch was reported
    // as a corrupt certificate.
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
   * The list in `wire.ts` is what `signature_algorithms` advertises, and this is
   * what stops it advertising something this file cannot import. Add a scheme to
   * the `SignatureScheme` union without a case in `importLeafKey` and the switch
   * falls through to `illegal_parameter` — every server offering that scheme gets
   * refused, on a handshake we invited by naming it.
   *
   * The key-per-scheme table is deliberately a SECOND statement of what each
   * scheme means, not a read of `verify.ts`'s own: `Record<SignatureScheme, …>`
   * makes an unlisted scheme a compile error, and generating the key the scheme
   * names is what makes a listed one more than an entry in two tables.
   */
  it('every scheme the client offers is one importLeafKey can import', async () => {
    const spkiOf = async (key: CryptoKey): Promise<Uint8Array> =>
      new Uint8Array(await crypto.subtle.exportKey('spki', key));

    // WebCrypto exports an RSA-PSS public key under the rsaEncryption OID, which
    // is what §4.3.3 requires of `rsa_pss_rsae_*` — an id-RSASSA-PSS key belongs
    // to `rsa_pss_pss_*` and is refused above.
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
   * The other half: that a signature made under each scheme actually VERIFIES.
   *
   * RFC 8448 is a SHA-256 document, so its traces exercise
   * `rsa_pss_rsae_sha256` and nothing else — until now the only thing standing
   * behind the two larger PSS digests was BoGo, which needs a Go toolchain and
   * a 337MB checkout. A salt length off by 16 bytes is invisible to `pnpm test`
   * and rejects every signature a real server makes with that scheme; §4.3.3
   * fixes it at the digest's own output length, and nothing else in this file
   * reads that requirement.
   *
   * Signing here rather than replaying a vector: WebCrypto is both sides, so
   * what this pins is that `verifyCertificateVerify` names the same parameters
   * the signer did — which is exactly the mistake being guarded against.
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
