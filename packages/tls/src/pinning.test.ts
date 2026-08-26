/**
 * The pin itself, and the wrapper's ordering.
 *
 * What a real handshake does with these is `interop.test.ts` — the two halves of
 * the M9 gate, against a server that reissues. Here the question is narrower:
 * that the pin is a digest of the right bytes, and that a matching pin can never
 * carry a chain the inner validator refused.
 */

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
  /**
   * Against `node:crypto` rather than a transcribed constant. A hard-coded
   * digest checks that this function still does what it did last week; a second
   * implementation checks that it does what it CLAIMS, which is SHA-256 over
   * exactly these bytes with nothing prepended.
   */
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

  /**
   * The property the whole mechanism rests on, stated over real certificates
   * rather than over raw keys: a reissue is a different document — different
   * serial, different validity, different signature — and the pin does not move.
   */
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
   * The direction that would make pinning a way to WEAKEN validation, and the
   * setup is the load-bearing part: the request carries a REAL leaf and the pin
   * is that leaf's own SPKI, so a wrapper that reached for the pin first — from
   * the only place it could, `request.peerCertificateDer` — would find a match
   * and return `ok` for a chain nothing trusts.
   *
   * An earlier version pinned three invented bytes against an empty request.
   * That pin matched nothing anywhere, so the dangerous branch was unreachable
   * and the test passed for a wrapper that skipped the inner validator entirely.
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
