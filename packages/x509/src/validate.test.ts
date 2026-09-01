/** Real signed chains, in `pnpm test`; x509-limbo cannot run here. */
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
    // A different name, so no candidate path exists at all.
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

/** Two bypasses found by review, as chains. */
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

/** Both halves: refuse leaves issued after the cutoff, keep anchoring those issued before it. */
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
   * Keyed on the leaf, not the clock. The obvious test (validate before the cutoff with a leaf issued
   * after it) is unreachable: a leaf is never valid before its own `notBefore`.
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
