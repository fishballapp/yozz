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

  /** `cacert.pem` ships this root unannotated; only `certdata.txt` carries the cutoff. */
  it('carries exactly one distrust-after cutoff, and it is Izenpe', () => {
    const distrusted = ROOT_BUNDLE.filter(entry => entry.serverDistrustAfter !== null);
    expect(distrusted.length).toBe(1);
    const [entry] = distrusted;
    expect(entry?.serverDistrustAfter?.toISOString()).toBe('2026-04-15T23:59:59.000Z');
    const subject = String.fromCharCode(...(entry?.subjectDer ?? new Uint8Array()));
    expect(subject).toContain('Izenpe');
  });

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
