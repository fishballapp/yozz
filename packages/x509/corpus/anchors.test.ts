/**
 * M5's gate, minus the part the limbo harness already covers.
 *
 * The suite proves the compiled provider returns the SAME verdicts as an
 * unindexed scan. What it cannot show is the reason the provider exists — that
 * a lookup does not parse the store — or that removing a root is visible. Those
 * are here.
 */
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

  /**
   * The property, proved directly rather than counted: a lookup never parses a
   * certificate. The entry below carries a valid subject with GARBAGE bytes, so
   * anything that decoded during compile or lookup would throw — and nothing
   * does. What the validator does with those bytes afterwards is its business.
   */
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
   * Indexing is the BUILD-time cost and does not ship; loading plus the first
   * usable anchor is what a cold page pays. The ceiling is deliberately loose —
   * it is a regression guard against the runtime path decoding the whole store
   * again, not a benchmark, and a tight wall-clock here would only be noise.
   *
   * Measured on this machine: 120 roots, ~3.1ms to index, ~0.33ms to first
   * usable anchor, against the 314ms the spike measured for parsing a bundle
   * eagerly. So the 50ms ceiling sits ~150x above the real cost and ~6x below
   * the regression it exists to catch.
   *
   * **There is deliberately no `loadingMs < indexingMs` comparison, and it was
   * removed for flaking.** It read as the stronger assertion and was in fact
   * the weaker one twice over. The loading window is ~0.33ms, so under
   * `pnpm test` — 44 packages running at once — a single OS deschedule inside
   * it is a 10x perturbation, while the same hiccup inside the 3ms indexing
   * window barely moves the baseline it was being compared against. A
   * sub-millisecond wall-clock measured under contention is a coin flip, not a
   * bound.
   *
   * And it was redundant. The claim it stood for — the runtime path does not
   * decode the whole store — is already asserted STRUCTURALLY by `parses no
   * certificate while building the index or serving a lookup`, which hands the
   * store entries whose DER cannot parse at all, so any parse throws rather
   * than merely costing time. Mutating `findCandidates` to decode every entry
   * fails that test on a `DerError` and leaves this one green, which is the
   * right division of labour: the structural test proves the property, and this
   * one is only a backstop against a cost that is real but not a parse.
   */
  it('pays a cold cost far below the build-time one', () => {
    const index = indexAnchors(bundle);

    const startedLoading = performance.now();
    const store = compileAnchors(index);
    const entry = index[0];
    if (entry === undefined) throw new Error('the bundle is empty');
    // The whole runtime path, not the lookup alone: the validator decodes the
    // candidate it is handed, and measuring only `findCandidates` would hide it.
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

/**
 * A root being distrusted upstream is a thing that HAPPENS — Symantec, Camerfirma,
 * Entrust. The failure has to be a verdict, not a silent fallback to some other
 * path, which is exactly the class of bug a dual-read bridge would introduce.
 */
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
