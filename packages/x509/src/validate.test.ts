/**
 * The validator, end to end, on REAL signed chains — and in `pnpm test`.
 *
 * x509-limbo is the exhaustive gate and it cannot run here: the corpus is 39MB
 * and gitignored, so `limbo:ours` is a separate manual command. That gap is not
 * hypothetical. Two authentication bypasses shipped through every green gate
 * because nothing in the standard test path exercised `validate.ts` at all.
 *
 * These are the few vectors that must never regress silently.
 */
import { describe, expect, it } from 'vitest';
import { compileAnchors, indexAnchors } from './anchors.ts';
import { type IssuedCertificate, issueCertificate, SERVER_AUTH } from './certificate-builder.ts';
import { YOZZ_VALIDATOR } from './validate.ts';
import type { PathValidationResult } from './validator.ts';

const validate = async ({
  leaf,
  intermediates = [],
  root,
  host = 'mail.example.com',
  at = new Date(),
  serverDistrustAfter = null,
}: {
  leaf: IssuedCertificate;
  intermediates?: readonly IssuedCertificate[];
  root: IssuedCertificate;
  host?: string;
  at?: Date;
  serverDistrustAfter?: Date | null;
}): Promise<PathValidationResult> =>
  YOZZ_VALIDATOR.validatePath({
    peerCertificateDer: leaf.der,
    untrustedIntermediateDer: intermediates.map(certificate => certificate.der),
    trustAnchors: compileAnchors(indexAnchors([{ id: 'root', der: root.der, serverDistrustAfter }]))
      .source,
    validationTime: at,
    expectedPeerName: { kind: 'dns', value: host },
    requiredKeyUsages: [],
    requiredExtendedKeyUsages: [],
    maximumIntermediateCount: null,
  });

const failureOf = (result: PathValidationResult): string =>
  result.ok ? 'ACCEPTED' : result.reason.code;

const newRoot = (commonName = 'Test Root'): Promise<IssuedCertificate> =>
  issueCertificate({ commonName, isCa: true });

const newLeaf = (
  issuer: IssuedCertificate,
  overrides: Parameters<typeof issueCertificate>[0] extends infer T ? Partial<T> : never = {},
): Promise<IssuedCertificate> =>
  issueCertificate({
    commonName: 'mail.example.com',
    issuer,
    dnsNames: ['mail.example.com'],
    extendedKeyUsages: [SERVER_AUTH],
    ...overrides,
  });

describe('a chain that should validate', () => {
  it('accepts root -> leaf', async () => {
    const root = await newRoot();
    expect((await validate({ leaf: await newLeaf(root), root })).ok).toBe(true);
  });

  it('accepts root -> intermediate -> leaf', async () => {
    const root = await newRoot();
    const intermediate = await issueCertificate({
      commonName: 'Test Intermediate',
      issuer: root,
      isCa: true,
    });
    const leaf = await newLeaf(intermediate);
    expect((await validate({ leaf, intermediates: [intermediate], root })).ok).toBe(true);
  });
});

describe('the checks that make it a validator', () => {
  it('rejects a leaf signed by a key that is not the issuer of record', async () => {
    const root = await newRoot();
    const impostor = await newRoot();
    const leaf = await newLeaf(root, { signWith: impostor.keyPair.privateKey });
    expect(failureOf(await validate({ leaf, root }))).toBe('invalid-signature');
  });

  it('rejects a chain to a root it was never given', async () => {
    const root = await newRoot();
    // A DIFFERENT name, so no candidate path exists at all. Same name with a
    // different key is the test above, and dies on the signature instead.
    const stranger = await newRoot('Unrelated Root');
    const leaf = await newLeaf(stranger);
    expect(failureOf(await validate({ leaf, root }))).toBe('no-path-to-trust-anchor');
  });

  it('rejects an expired leaf', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, {
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2021-01-01T00:00:00Z'),
    });
    expect(failureOf(await validate({ leaf, root }))).toBe('certificate-expired');
  });

  it('rejects a host the certificate does not name', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root);
    expect(failureOf(await validate({ leaf, root, host: 'other.example.com' }))).toBe(
      'name-mismatch',
    );
  });

  it('rejects a leaf with no serverAuth extended key usage', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, { extendedKeyUsages: [] });
    expect(failureOf(await validate({ leaf, root }))).toBe('extended-key-usage-violation');
  });
});

/**
 * The two bypasses a cross-model review found, as chains rather than as matcher
 * probes. Both passed `pnpm check` and `pnpm test` at the time.
 */
describe('the constrained-issuer bypasses', () => {
  it('rejects a wildcard leaf reaching into a subtree its issuer excludes', async () => {
    const root = await newRoot();
    const intermediate = await issueCertificate({
      commonName: 'Constrained CA',
      issuer: root,
      isCa: true,
      excludedDnsNames: ['mail.example.com'],
    });
    const leaf = await newLeaf(intermediate, {
      commonName: '*.example.com',
      dnsNames: ['*.example.com'],
    });
    expect(failureOf(await validate({ leaf, intermediates: [intermediate], root }))).toBe(
      'name-constraints-violation',
    );
  });

  it('rejects a leaf issued by a CA restricted away from serverAuth', async () => {
    const root = await newRoot();
    const intermediate = await issueCertificate({
      commonName: 'Client-only CA',
      issuer: root,
      isCa: true,
      extendedKeyUsages: ['1.3.6.1.5.5.7.3.2'],
    });
    const leaf = await newLeaf(intermediate);
    expect(failureOf(await validate({ leaf, intermediates: [intermediate], root }))).toBe(
      'extended-key-usage-violation',
    );
  });

  it('still accepts a wildcard the same issuer permits', async () => {
    const root = await newRoot();
    const intermediate = await issueCertificate({
      commonName: 'Constrained CA',
      issuer: root,
      isCa: true,
      permittedDnsNames: ['example.com'],
    });
    const leaf = await newLeaf(intermediate, {
      commonName: '*.example.com',
      dnsNames: ['*.example.com'],
    });
    expect((await validate({ leaf, intermediates: [intermediate], root })).ok).toBe(true);
  });
});

/**
 * Mozilla retires a CA by refusing what it issues from a date onward, not by
 * removing it — so this needs BOTH halves or it means nothing. A rule that
 * simply drops the root passes the refusal half perfectly and fails the other,
 * and it would take down every chain the CA signed before the cutoff: mail that
 * works in every browser, failing only in YOZZ, for up to the 60-90 days a
 * public leaf lives.
 */
describe('a root past its server distrust-after', () => {
  const CUTOFF = new Date('2026-04-15T23:59:59Z');
  const BEFORE = new Date('2026-03-01T00:00:00Z');
  const AFTER = new Date('2026-05-01T00:00:00Z');

  it('still anchors a leaf issued before the cutoff', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, { notBefore: BEFORE });
    const result = await validate({ leaf, root, at: AFTER, serverDistrustAfter: CUTOFF });
    expect(failureOf(result)).toBe('ACCEPTED');
  });

  it('refuses a leaf issued after it', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, { notBefore: AFTER });
    const result = await validate({ leaf, root, at: AFTER, serverDistrustAfter: CUTOFF });
    expect(failureOf(result)).toBe('certificate-authority-distrusted');
  });

  /**
   * The rule keys on the LEAF, not on the clock — and the accept above is what
   * proves it, which is worth saying because the obvious test for it cannot
   * exist.
   *
   * "Validate before the cutoff with a leaf issued after it" is unreachable: a
   * certificate is not valid before its own `notBefore`, so `validationTime` is
   * never earlier than it, and such a chain dies on `certificate-not-yet-valid`
   * long before the distrust check. The reachable discriminator is the other
   * way round — validating well AFTER the cutoff with a leaf issued before it,
   * which is exactly the first test here. Key the rule on `validationTime` and
   * that test goes red.
   *
   * A first draft of this file asserted the unreachable direction, passed, and
   * measured nothing: it set `at` to a moment after the cutoff and was a
   * duplicate of the refusal below.
   */
  it('refuses on the leaf even when the chain is otherwise current', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, { notBefore: AFTER });
    const result = await validate({
      leaf,
      root,
      at: new Date('2026-05-02T00:00:00Z'),
      serverDistrustAfter: CUTOFF,
    });
    expect(failureOf(result)).toBe('certificate-authority-distrusted');
    // The chain is valid on every other axis at that instant, so the refusal is
    // the distrust rule and not an expiry sneaking in.
    expect(failureOf(await validate({ leaf, root, at: new Date('2026-05-02T00:00:00Z') }))).toBe(
      'ACCEPTED',
    );
  });

  it('leaves a root with no cutoff alone', async () => {
    const root = await newRoot();
    const leaf = await newLeaf(root, { notBefore: AFTER });
    expect(failureOf(await validate({ leaf, root, at: AFTER }))).toBe('ACCEPTED');
  });
});
