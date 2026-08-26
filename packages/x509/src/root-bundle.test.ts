/**
 * The shipped trust store, as committed. These numbers ARE the trust decision —
 * if one moves, a pin moved, and somebody should have read what changed before
 * pasting a hash.
 */
import { describe, expect, it } from 'vitest';
import { compileAnchors } from './anchors.ts';
import { decodeCertificate } from './certificate.ts';
import { ROOT_BUNDLE } from './root-bundle-generated.ts';

describe('the shipped root bundle', () => {
  it('holds every root curl ships, and each one decodes', () => {
    expect(ROOT_BUNDLE.length).toBe(121);
    for (const entry of ROOT_BUNDLE) {
      expect(() => decodeCertificate(entry.der)).not.toThrow();
    }
  });

  /**
   * The whole reason the build reads a second file. `cacert.pem` ships this
   * root unannotated, and a build that only read the PEM would trust it for
   * certificates issued today — which Firefox does not.
   */
  it('carries exactly one distrust-after cutoff, and it is Izenpe', () => {
    const distrusted = ROOT_BUNDLE.filter(entry => entry.serverDistrustAfter !== null);
    expect(distrusted.length).toBe(1);
    const [entry] = distrusted;
    expect(entry?.serverDistrustAfter?.toISOString()).toBe('2026-04-15T23:59:59.000Z');
    // `Name` keeps DER rather than text on purpose, so the name is checked as bytes.
    const subject = String.fromCharCode(...(entry?.subjectDer ?? new Uint8Array()));
    expect(subject).toContain('Izenpe');
  });

  /** The cutoff has to survive the compile, or enforcement never sees it. */
  it('hands the cutoff to the validator through compileAnchors', () => {
    const distrusted = ROOT_BUNDLE.find(entry => entry.serverDistrustAfter !== null);
    if (distrusted === undefined) throw new Error('no distrusted root to check');
    const { source } = compileAnchors(ROOT_BUNDLE);
    const [candidate] = source.findCandidates({
      issuerNameDer: distrusted.subjectDer,
      authorityKeyIdentifier: null,
    });
    expect(candidate?.serverDistrustAfter?.toISOString()).toBe('2026-04-15T23:59:59.000Z');
  });
});
