/** The pin is a digest of the right bytes, and a matching pin never carries a refused chain. `interop.test.ts` has the rest. */

import { createHash } from 'node:crypto';
import {
  decodeCertificate,
  issueCertificate,
  type PathValidationRequest,
  type PathValidationResult,
  SERVER_AUTH,
  type ValidatedPath,
  type Validator,
} from '@yozz.app/x509';
import { describe, expect, it, vi } from 'vitest';
import { pinnedValidator, publicKeyPin } from './pinning.ts';

const REQUEST: PathValidationRequest = {
  peerCertificateDer: Uint8Array.of(),
  untrustedIntermediateDer: [],
  trustAnchors: { findCandidates: () => [] },
  validationTime: new Date(),
  expectedPeerName: null,
  requiredKeyUsages: [],
  requiredExtendedKeyUsages: [],
  maximumIntermediateCount: null,
};

const pathWith = (leafSubjectPublicKeyInfoDer: Uint8Array): ValidatedPath => ({
  leafSubjectPublicKeyInfoDer,
  intermediates: [],
  trustAnchorId: 'test-anchor',
});

const validatorReturning = (result: PathValidationResult): Validator => ({
  name: 'test',
  validatePath: vi.fn(async () => result),
});

const spkiOf = async (keyPair: CryptoKeyPair): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));

describe('publicKeyPin', () => {
  /** Against `node:crypto`, so this checks what the function claims rather than what it did last week. */
  it('is base64 of SHA-256 over the SPKI DER, and nothing else', async () => {
    const spki = await spkiOf(
      await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]),
    );

    expect(await publicKeyPin(spki)).toBe(
      createHash('sha256').update(Buffer.from(spki)).digest('base64'),
    );
  });

  /** A reissue is a different document with the same key, and the pin does not move. */
  it('is unchanged by a reissue over the same key, and changes when the key does', async () => {
    const root = await issueCertificate({ commonName: 'pin test root', isCa: true });
    const first = await issueCertificate({
      commonName: 'mail.example',
      issuer: root,
      dnsNames: ['mail.example'],
      extendedKeyUsages: [SERVER_AUTH],
    });
    const renewed = await issueCertificate({
      commonName: 'mail.example',
      issuer: root,
      dnsNames: ['mail.example'],
      extendedKeyUsages: [SERVER_AUTH],
      keyPair: first.keyPair,
      notAfter: new Date(Date.now() + 90 * 24 * 3600 * 1000),
    });
    const rotated = await issueCertificate({
      commonName: 'mail.example',
      issuer: root,
      dnsNames: ['mail.example'],
      extendedKeyUsages: [SERVER_AUTH],
    });

    // Otherwise "the pin did not move" would be reading the same certificate twice.
    expect(Buffer.from(renewed.der).equals(Buffer.from(first.der))).toBe(false);

    const pin = await publicKeyPin(await spkiOf(first.keyPair));
    expect(await publicKeyPin(await spkiOf(renewed.keyPair))).toBe(pin);
    expect(await publicKeyPin(await spkiOf(rotated.keyPair))).not.toBe(pin);
  });
});

describe('pinnedValidator', () => {
  it('returns the inner path untouched when the leaf key is the pinned one', async () => {
    const spki = Uint8Array.of(1, 2, 3);
    const path = pathWith(spki);
    const inner = validatorReturning({ ok: true, path });

    const result = await pinnedValidator({
      validator: inner,
      pin: await publicKeyPin(spki),
    }).validatePath(REQUEST);

    expect(result).toEqual({ ok: true, path });
    expect(inner.validatePath).toHaveBeenCalledTimes(1);
  });

  it('refuses a valid chain carrying a different key, as a policy refusal', async () => {
    const result = await pinnedValidator({
      validator: validatorReturning({ ok: true, path: pathWith(Uint8Array.of(1, 2, 3)) }),
      pin: await publicKeyPin(Uint8Array.of(9, 9, 9)),
    }).validatePath(REQUEST);

    expect(result).toEqual({ ok: false, reason: { code: 'rejected-by-policy' } });
  });

  /**
   * The request carries a real leaf whose own SPKI is the pin, so a wrapper that read the pin
   * before the inner validator would find a match and return `ok` for a chain nothing trusts.
   */
  it('never lets a matching pin rescue a chain the inner validator refused', async () => {
    const root = await issueCertificate({ commonName: 'rescue test root', isCa: true });
    const leaf = await issueCertificate({
      commonName: 'mail.example',
      issuer: root,
      dnsNames: ['mail.example'],
      extendedKeyUsages: [SERVER_AUTH],
    });
    const request: PathValidationRequest = { ...REQUEST, peerCertificateDer: leaf.der };
    const inner = validatorReturning({ ok: false, reason: { code: 'no-path-to-trust-anchor' } });

    const result = await pinnedValidator({
      validator: inner,
      pin: await publicKeyPin(decodeCertificate(leaf.der).subjectPublicKeyInfo.der),
    }).validatePath(request);

    expect(result).toEqual({ ok: false, reason: { code: 'no-path-to-trust-anchor' } });
    expect(inner.validatePath).toHaveBeenCalledWith(request);
  });

  it('names the validator it wraps, so a failure report says which policy refused', () => {
    expect(
      pinnedValidator({
        validator: validatorReturning({ ok: true, path: pathWith(Uint8Array.of()) }),
        pin: 'x',
      }).name,
    ).toBe('test+spki-pin');
  });
});
