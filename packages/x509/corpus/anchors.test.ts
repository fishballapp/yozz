/** What the limbo harness cannot show: a lookup does not parse the store, and a removed root is visible. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { derFromPem } from '../harness/pem.ts';
import { LIMBO_CACHE } from '../harness/pin.ts';
import { compileAnchors, indexAnchors } from '../src/anchors.ts';
import { decodeCertificate } from '../src/certificate.ts';
import { YOZZ_VALIDATOR } from '../src/validate.ts';

/** Node ships Mozilla's NSS list, which is the store a browser-facing client wants. */
const bundle = rootCertificates.flatMap((pem, index) =>
  derFromPem(pem).map(der => ({ id: `nss#${index}`, der })),
);

describe('the compiled store', () => {
  it('holds a real root list', () => {
    expect(bundle.length).toBeGreaterThan(100);
  });

  /** Entries carry garbage bytes under a valid subject, so any decode during compile or lookup throws. */
  it('parses no certificate while building the index or serving a lookup', () => {
    const index = indexAnchors(bundle);
    const real = index[0];
    if (real === undefined) throw new Error('the bundle is empty');

    const store = compileAnchors([
      ...index,
      {
        id: 'not-a-certificate',
        der: Uint8Array.of(0xff, 0xff, 0xff),
        subjectDer: real.subjectDer,
        serverDistrustAfter: null,
      },
    ]);
    const found = store.source.findCandidates({
      issuerNameDer: real.subjectDer,
      authorityKeyIdentifier: null,
    });
    expect(found.map(anchor => anchor.id)).toContain('not-a-certificate');
    expect(store.size).toBe(index.length + 1);
  });

  it('returns only the candidates matching the issuer, not the store', () => {
    const index = indexAnchors(bundle);
    const store = compileAnchors(index);
    const entry = index[0];
    if (entry === undefined) throw new Error('the bundle is empty');
    const found = store.source.findCandidates({
      issuerNameDer: entry.subjectDer,
      authorityKeyIdentifier: null,
    });
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(store.size);
  });

  /**
   * A loose ceiling: a regression guard against decoding the whole store, not a benchmark. Measured
   * ~0.33 ms to first usable anchor against the 314 ms the spike saw. No `loadingMs < indexingMs`
   * comparison: sub-millisecond wall clock under `pnpm test` contention is a coin flip.
   */
  it('pays a cold cost far below the build-time one', () => {
    const index = indexAnchors(bundle);

    const startedLoading = performance.now();
    const store = compileAnchors(index);
    const entry = index[0];
    if (entry === undefined) throw new Error('the bundle is empty');
    // The whole runtime path: the validator decodes the candidate it is handed.
    const anchor = store.source.findCandidates({
      issuerNameDer: entry.subjectDer,
      authorityKeyIdentifier: null,
    })[0];
    if (anchor === undefined) throw new Error('the root did not find itself');
    decodeCertificate(anchor.certificateDer);
    const loadingMs = performance.now() - startedLoading;

    expect(loadingMs).toBeLessThan(50);
  });
});

/** A distrusted root must be a verdict, never a silent fallback. */
describe.skipIf(!existsSync(LIMBO_CACHE))('a distrusted root', () => {
  it('turns a chain that validated into one that visibly does not', async () => {
    const { testcases } = z
      .object({
        testcases: z.array(
          z.object({
            id: z.string(),
            expected_result: z.enum(['SUCCESS', 'FAILURE']),
            validation_kind: z.enum(['CLIENT', 'SERVER']),
            trusted_certs: z.array(z.string()),
            untrusted_intermediates: z.array(z.string()),
            peer_certificate: z.string(),
            validation_time: z.string().nullable(),
            expected_peer_name: z.object({ kind: z.string(), value: z.string() }).nullable(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(LIMBO_CACHE, 'utf8')));

    const testcase = testcases.find(
      candidate =>
        candidate.expected_result === 'SUCCESS' &&
        candidate.validation_kind === 'SERVER' &&
        candidate.expected_peer_name?.kind === 'DNS' &&
        candidate.trusted_certs.length === 1,
    );
    if (testcase === undefined) throw new Error('no single-root success case to distrust');

    const peerName = testcase.expected_peer_name;
    if (peerName === null) throw new Error('the chosen case has no peer name');
    const roots = testcase.trusted_certs
      .flatMap(derFromPem)
      .map((der, index) => ({ id: `root#${index}`, der }));

    const validateWith = async (anchors: typeof roots) =>
      YOZZ_VALIDATOR.validatePath({
        peerCertificateDer: decodeCertificate(
          derFromPem(testcase.peer_certificate)[0] ?? new Uint8Array(),
        ).der,
        untrustedIntermediateDer: testcase.untrusted_intermediates.flatMap(derFromPem),
        trustAnchors: compileAnchors(indexAnchors(anchors)).source,
        validationTime:
          testcase.validation_time === null ? new Date() : new Date(testcase.validation_time),
        expectedPeerName: { kind: 'dns', value: peerName.value },
        requiredKeyUsages: [],
        requiredExtendedKeyUsages: [],
        maximumIntermediateCount: null,
      });

    expect((await validateWith(roots)).ok).toBe(true);

    const distrusted = await validateWith([]);
    expect(distrusted.ok).toBe(false);
    expect(distrusted.ok === false && distrusted.reason.code).toBe('no-path-to-trust-anchor');
  });
});
