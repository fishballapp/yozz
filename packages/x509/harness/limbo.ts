/**
 * Runs x509-limbo against a Validator and reports the two rates apart.
 *
 * 926 of the relevant cases expect SUCCESS, so a validator that rejects
 * everything scores 8850 and is worthless. One number here would hide that.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { compileAnchors, indexAnchors } from '../src/anchors.ts';
import { YOZZ_VALIDATOR } from '../src/validate.ts';
import type { PathValidationRequest, PeerName, TrustAnchorSource } from '../src/validator.ts';
import { OPENSSL_VALIDATOR } from './openssl.ts';
import { derFromPem } from './pem.ts';
import { LIMBO_CACHE, LIMBO_COMMIT, LIMBO_SHA256 } from './pin.ts';
import { isSkipped, PROFILE } from './profile.ts';

const TestcaseSchema = z.object({
  id: z.string(),
  validation_kind: z.enum(['CLIENT', 'SERVER']),
  expected_result: z.enum(['SUCCESS', 'FAILURE']),
  features: z.array(z.string()),
  trusted_certs: z.array(z.string()),
  untrusted_intermediates: z.array(z.string()),
  peer_certificate: z.string(),
  validation_time: z.string().nullable(),
  key_usage: z.array(z.string()),
  extended_key_usage: z.array(z.string()),
  /**
   * The schema's `PeerKind` is DNS | IP | RFC822. Enumerated rather than left as a
   * string so a pin bump that introduces RFC822 fails loudly here, instead of being
   * silently mapped to a DNS name check.
   */
  expected_peer_name: z
    .object({ kind: z.enum(['DNS', 'IP', 'RFC822']), value: z.string() })
    .nullable(),
  max_chain_depth: z.number().nullable(),
});
type Testcase = z.infer<typeof TestcaseSchema>;

/** `version` is asserted so a future schema revision cannot be read as if it were this one. */
const CorpusSchema = z.object({ version: z.literal(1), testcases: z.array(z.unknown()) });

const firstDer = (pem: string): Uint8Array => {
  const [der] = derFromPem(pem);
  if (der === undefined) throw new Error('testcase certificate contained no PEM block');
  return der;
};

const peerNameFrom = (name: Testcase['expected_peer_name']): PeerName | null => {
  if (name === null) return null;
  if (name.kind === 'IP') return { kind: 'ip', value: name.value };
  if (name.kind === 'DNS') return { kind: 'dns', value: name.value };
  // Today's corpus is DNS and IP only. Falling through to a DNS check would quietly
  // test the wrong thing, so a new kind stops the run instead.
  throw new Error(`unsupported peer name kind: ${name.kind}`);
};

const anchorsOf = (testcase: Testcase): { id: string; der: Uint8Array }[] =>
  testcase.trusted_certs
    .flatMap(derFromPem)
    .map((der, index) => ({ id: `${testcase.id}#${index}`, der }));

/**
 * Unindexed, and it MUST stay that way for the control.
 *
 * `indexAnchors` reads a subject out of every certificate with OUR decoder and
 * drops the ones it cannot read. Feeding that to OpenSSL would mean the control
 * only ever sees roots we already approved of — a control that shares our code
 * is not a control, it is a mirror. It also hard-fails, because a case whose
 * roots we dropped hands `openssl verify` an empty roots.pem.
 */
const unindexedAnchorsFor = (testcase: Testcase): TrustAnchorSource => {
  // x509-limbo supplies its own roots per case and carries no distrust metadata.
  const anchors = anchorsOf(testcase).map(({ id, der }) => ({
    id,
    certificateDer: der,
    serverDistrustAfter: null,
  }));
  return { findCandidates: () => anchors };
};

/**
 * The COMPILED provider from M5, for our validator only. The M5 gate is that it
 * changes no verdict: run `--anchors=unindexed` and the numbers must be
 * identical, which is what makes an index that silently loses a candidate
 * visible as a chain that stopped building.
 */
const compiledAnchorsFor = (testcase: Testcase): TrustAnchorSource =>
  compileAnchors(indexAnchors(anchorsOf(testcase))).source;

const requestFrom = (testcase: Testcase): PathValidationRequest => ({
  peerCertificateDer: firstDer(testcase.peer_certificate),
  untrustedIntermediateDer: testcase.untrusted_intermediates.flatMap(derFromPem),
  trustAnchors: anchorSourceFor(testcase),
  validationTime:
    testcase.validation_time === null ? new Date() : new Date(testcase.validation_time),
  expectedPeerName: peerNameFrom(testcase.expected_peer_name),
  requiredKeyUsages: testcase.key_usage,
  requiredExtendedKeyUsages: testcase.extended_key_usage,
  maximumIntermediateCount: testcase.max_chain_depth,
});

const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
};

// Verify the corpus here, not only at fetch time. A truncated or swapped
// .limbo/limbo.json otherwise reports `0/0 (0.0%)` and `0 disagreements` without
// throwing — a perfect score over nothing at all.
const cached = await readFile(LIMBO_CACHE);
const actualHash = createHash('sha256').update(cached).digest('hex');
if (actualHash !== LIMBO_SHA256) {
  throw new Error(
    `corpus does not match the pin.\n  expected ${LIMBO_SHA256}\n  actual   ${actualHash}\n` +
      'Re-run `pnpm -F @yozz.app/x509 limbo:fetch`.',
  );
}

const raw = CorpusSchema.parse(JSON.parse(cached.toString('utf8')));
const all = raw.testcases.map(testcase => TestcaseSchema.parse(testcase));
if (all.length === 0) throw new Error('corpus parsed to zero testcases');

const ours = all.filter(testcase => testcase.validation_kind === 'SERVER');
const skips = new Map<string, number>();
const executed: Testcase[] = [];
for (const testcase of ours) {
  const reason = isSkipped(testcase.id, testcase.features);
  if (reason === undefined) executed.push(testcase);
  else skips.set(reason, (skips.get(reason) ?? 0) + 1);
}

console.log(`x509-limbo @ ${LIMBO_COMMIT.slice(0, 10)}  profile=${PROFILE}`);
console.log(`  ${all.length} testcases, ${ours.length} SERVER (client-side validation)`);
console.log(`  ${executed.length} executed, ${ours.length - executed.length} skipped:`);
for (const [reason, count] of [...skips].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(count).padStart(4)}  ${reason}`);
}

/**
 * Which implementation is under test. The control and the real thing run through
 * the SAME runner, because a suite that scores them differently is comparing two
 * harnesses rather than two validators.
 */
const VALIDATORS = { openssl: OPENSSL_VALIDATOR, yozz: YOZZ_VALIDATOR } as const;
const selected = process.argv.find(argument => argument.startsWith('--validator='))?.split('=')[1];
const VALIDATOR = VALIDATORS[selected === 'yozz' ? 'yozz' : 'openssl'];

/**
 * The control never gets the compiled provider; `--anchors=unindexed` forces our
 * validator onto the same plain source so the two can be compared directly.
 */
const isUnindexedForced = process.argv.includes('--anchors=unindexed');
const anchorSourceFor =
  VALIDATOR === OPENSSL_VALIDATOR || isUnindexedForced ? unindexedAnchorsFor : compiledAnchorsFor;

const started = performance.now();
const outcomes = await mapWithConcurrency(executed, 12, async testcase => {
  const result = await VALIDATOR.validatePath(requestFrom(testcase));
  const expected = testcase.expected_result === 'SUCCESS';
  return { testcase, agreed: result.ok === expected };
});
const elapsed = ((performance.now() - started) / 1000).toFixed(1);

const positives = outcomes.filter(o => o.testcase.expected_result === 'SUCCESS');
const negatives = outcomes.filter(o => o.testcase.expected_result === 'FAILURE');
const rate = (group: typeof outcomes): string => {
  const agreed = group.filter(o => o.agreed).length;
  const pct = group.length === 0 ? 0 : (agreed / group.length) * 100;
  return `${agreed}/${group.length} (${pct.toFixed(1)}%)`;
};

const label = VALIDATOR === OPENSSL_VALIDATOR ? ' (the control)' : '';
console.log(`\nvalidator: ${VALIDATOR.name}${label}   ${elapsed}s`);
console.log(`  must ACCEPT   ${rate(positives)}`);
console.log(`  must REJECT   ${rate(negatives)}`);

const mismatches = outcomes.filter(o => !o.agreed);
const unexpectedAccept = mismatches.filter(o => o.testcase.expected_result === 'FAILURE');
const unexpectedReject = mismatches.filter(o => o.testcase.expected_result === 'SUCCESS');

console.log(`\n${mismatches.length} disagreements`);
console.log(`  ${unexpectedAccept.length} accepted but should have been rejected`);
console.log(`  ${unexpectedReject.length} rejected but should have been accepted`);

const byNamespace = (group: typeof outcomes): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const { testcase } of group) {
    const parts = testcase.id.split('::');
    const key = parts.length > 2 ? `${parts[0]}::${parts[1]}` : (parts[0] ?? '');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
for (const [label, group] of [
  ['accepted, should reject', unexpectedAccept],
  ['rejected, should accept', unexpectedReject],
] as const) {
  console.log(`\n  ${label}, by namespace:`);
  for (const [ns, count] of [...byNamespace(group)].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${String(count).padStart(4)}  ${ns}`);
  }
}

// Written so the set can be diffed against x509-limbo's own published results for
// the same implementation — the check that says whether the harness is right.
const REPORT = new URL('../.limbo/disagreements.txt', import.meta.url).pathname;
await writeFile(
  REPORT,
  mismatches
    .map(o => `${o.testcase.expected_result} ${o.testcase.id}`)
    .sort()
    .join('\n'),
);
console.log(`\nwrote ${mismatches.length} disagreement ids -> ${REPORT}`);

/**
 * The gate. Printing a disagreement count and exiting 0 is not one: both
 * `pnpm check` and `pnpm test` passed while this run accepted certificates that
 * should have been rejected, including two authentication bypasses.
 *
 * Only our own validator is gated — the control is a measurement, and OpenSSL's
 * disagreements are not ours to fix.
 */
if (VALIDATOR !== OPENSSL_VALIDATOR) {
  const expectedPath = new URL('expected-disagreements.txt', import.meta.url).pathname;
  const expected = new Set(
    (await readFile(expectedPath, 'utf8'))
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#')),
  );
  const actual = new Set(mismatches.map(outcome => outcome.testcase.id));
  const appeared = [...actual].filter(id => !expected.has(id));
  const disappeared = [...expected].filter(id => !actual.has(id));

  if (appeared.length > 0 || disappeared.length > 0) {
    for (const id of appeared) console.log(`  NEW disagreement, not in the expected set: ${id}`);
    for (const id of disappeared) console.log(`  fixed, remove from the expected set: ${id}`);
    console.log(`\n${expectedPath}`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${actual.size} disagreements are the expected ones`);
  }
}
