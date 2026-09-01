/**
 * ```
 * pnpm -F @yozz.app/tls bogo:inventory   # sweep every test, rebuild manifest.txt
 * pnpm -F @yozz.app/tls bogo             # the gate: every manifest test must pass
 * ```
 *
 * Re-run the inventory when the pin moves or the shim learns a flag: two scope rules classify a
 * test by what the peer did, and a declined test never gets that far. See DECISIONS.md,
 * "The BoGo gate".
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  BORINGSSL_CHECKOUT,
  BORINGSSL_COMMIT,
  BORINGSSL_TAG,
  BORINGSSL_TEST_COUNT,
  RUNNER_DIR,
} from './pin.ts';
import { excludedBy, type InventoryRow, RFC_DIVERGENCES, SCOPE_RULES } from './scope.ts';

const HERE = new URL('.', import.meta.url).pathname;
const WORK = `${BORINGSSL_CHECKOUT}/../work`;
const SHIM = `${HERE}shim.ts`;
const MANIFEST = `${HERE}manifest.txt`;
const EXPECTED = `${HERE}expected.txt`;
const SHIM_CONFIG = `${HERE}shim-config.json`;
const RUNNER_BINARY = `${WORK}/runner-${BORINGSSL_COMMIT.slice(0, 12)}.test`;
const RESULTS = `${WORK}/results.json`;
const DECISIONS = `${WORK}/decisions.jsonl`;
const TRANSCRIPTS = `${WORK}/transcripts`;

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
type Results = { readonly tests: Record<string, { actual: Outcome; error?: string }> };

/** `unexpected success` is the dangerous one: the client accepted what the suite says to refuse. */
const CATEGORIES = [
  ['unexpected success', 'we accepted it; the suite says refuse'],
  [
    'unexpected error',
    'we refused it, with an error the suite does not recognise as the right one',
  ],
  ['unexpected failure', 'we refused it; the suite says accept'],
] as const;

const categoryOf = (error: string): string =>
  CATEGORIES.find(([prefix]) => error.startsWith(prefix))?.[0] ?? 'other';

/** `want: local: "..." remote: ":SOME_ERROR:"` — the error BoringSSL would raise. */
const wanted = (error: string): string => error.match(/remote: "([^"]*)"/)?.[1] ?? '';
type Decision = {
  readonly decision: 'passed' | 'failed' | 'declined';
  readonly reason: string | null;
  readonly argv: readonly string[];
};

const buildRunner = (): void => {
  if (existsSync(RUNNER_BINARY)) return;
  console.log(`building the BoGo runner from boringssl ${BORINGSSL_TAG}`);
  mkdirSync(WORK, { recursive: true });
  execFileSync('go', ['test', '-c', '-o', RUNNER_BINARY, './ssl/test/runner'], {
    cwd: BORINGSSL_CHECKOUT,
    stdio: 'inherit',
  });
};

/** `-transcript-dir` is the only way the runner names the test to the shim (the `-write-settings` prefix). */
const runBogo = (extraArgs: readonly string[]): void => {
  rmSync(DECISIONS, { force: true });
  rmSync(TRANSCRIPTS, { force: true, recursive: true });
  // The previous run's results file must go before the runner starts; `.bogo/` is cached
  // whole in CI, and the runner exits non-zero for ordinary failures too.
  rmSync(RESULTS, { force: true });
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const result = spawnSync(
    RUNNER_BINARY,
    [
      '-shim-path',
      SHIM,
      '-shim-config',
      SHIM_CONFIG,
      '-json-output',
      RESULTS,
      '-transcript-dir',
      TRANSCRIPTS,
      ...extraArgs,
    ],
    { cwd: RUNNER_DIR, stdio: 'inherit', env: { ...process.env, YOZZ_BOGO_LOG: DECISIONS } },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    throw new Error(`the BoGo runner was killed by ${result.signal}`);
  }
  if (!existsSync(RESULTS)) {
    throw new Error(
      `the BoGo runner exited ${result.status} without writing ${RESULTS}. That is a broken run, not a result.`,
    );
  }
};

const readResults = (): Results => JSON.parse(readFileSync(RESULTS, 'utf8'));

const readDecisions = (): readonly Decision[] =>
  existsSync(DECISIONS)
    ? readFileSync(DECISIONS, 'utf8')
        .trim()
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line))
    : [];

/** `<dir>/tls/client/Some-Test-Name-` — protocol, side and name, from the runner. */
const settingsPrefix = (argv: readonly string[]): readonly string[] => {
  const index = argv.indexOf('-write-settings');
  return index === -1 ? [] : (argv[index + 1]?.split('/') ?? []);
};

const testNameOf = (argv: readonly string[]): string | null =>
  settingsPrefix(argv).at(-1)?.replace(/-$/, '') ?? null;

const decisionsByTest = (): Map<string, Decision> =>
  new Map(
    readDecisions().flatMap(decision => {
      const name = testNameOf(decision.argv);
      return name === null ? [] : [[name, decision] as const];
    }),
  );

/**
 * What each in-scope test does today, committed; the gate asserts nothing moved in either
 * direction. `FAIL` is deliberately not a value: a failing in-scope test is a defect, a mapping,
 * or a declared divergence in `scope.ts`.
 */
type Expectation = 'PASS' | 'SKIP';

const readExpected = (): Map<string, Expectation> =>
  new Map(
    readFileSync(EXPECTED, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
      .map(line => {
        const [outcome, ...rest] = line.split(/\s+/);
        return [rest.join(' '), outcome as Expectation] as const;
      }),
  );

const readManifest = (): readonly string[] =>
  readFileSync(MANIFEST, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'));

const count = <T>(items: Iterable<T>, key: (item: T) => string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return new Map([...counts].sort((a, b) => b[1] - a[1]));
};

const table = (counts: Map<string, number>): string =>
  [...counts].map(([key, n]) => `  ${String(n).padStart(5)}  ${key}`).join('\n');

const inventory = (): void => {
  runBogo(['-allow-unimplemented']);
  const results = readResults();
  const decisions = decisionsByTest();

  const rows: InventoryRow[] = [...decisions].flatMap(([name, decision]) => {
    const prefix = settingsPrefix(decision.argv);
    const protocol = prefix.at(-3);
    const side = prefix.at(-2);
    if (protocol === undefined || side === undefined) return [];
    return [
      {
        name,
        protocol: protocol as InventoryRow['protocol'],
        side: side as InventoryRow['side'],
        flags: decision.argv.filter(token => token.startsWith('-')),
        argv: decision.argv,
        peerRefusedVersion:
          /did not offer any supported protocol versions/.test(results.tests[name]?.error ?? '') ||
          decision.reason === 'yozz: alert-received protocol_version',
      },
    ];
  });

  // The runner exits non-zero during an inventory by design, so the count is the check.
  if (rows.length !== BORINGSSL_TEST_COUNT) {
    throw new Error(
      `the sweep saw ${rows.length} tests and pin.ts says the suite has ${BORINGSSL_TEST_COUNT}. ` +
        'Writing the manifest now would shrink the gate silently. Re-run it — and if the pin ' +
        'moved, bump BORINGSSL_TEST_COUNT with it.',
    );
  }

  const inScope = rows.filter(row => excludedBy(row) === undefined);
  const excluded = count(rows, row => excludedBy(row)?.id ?? 'in-scope');

  console.log(`\n${rows.length} tests in boringssl ${BORINGSSL_TAG}, by scope rule:\n`);
  console.log(table(excluded));
  for (const rule of SCOPE_RULES) console.log(`\n  ${rule.id} — ${rule.why}`);

  console.log('\nwhere we follow the RFC and BoringSSL does not:\n');
  for (const { test, rfc } of RFC_DIVERGENCES) console.log(`  ${test}\n      ${rfc}\n`);

  const names = inScope.map(row => row.name).sort();
  writeFileSync(
    MANIFEST,
    [
      '# The in-scope BoGo manifest: TLS 1.3, client, every one of which must PASS.',
      '#',
      '# Generated by `pnpm -F @yozz.app/tls bogo:inventory` from the pinned suite and the',
      '# rules in scope.ts. Committed, because a gate whose denominator moves silently',
      `# is not a gate. boringssl ${BORINGSSL_TAG}, ${names.length} of ${rows.length} tests.`,
      '',
      ...names,
      '',
    ].join('\n'),
  );
  console.log(`\nwrote ${names.length} in-scope test names -> harness/bogo/manifest.txt`);
};

// The comparison walks the manifest, so a name missing from it would go unchecked silently.
const namesDisagree = (manifest: readonly string[], expected: ReadonlyMap<string, unknown>) => {
  const inManifest = new Set(manifest);
  const missingFromExpected = manifest.filter(name => !expected.has(name));
  const missingFromManifest = [...expected.keys()].filter(name => !inManifest.has(name));
  const duplicated = manifest.filter((name, index) => manifest.indexOf(name) !== index);
  return { missingFromExpected, missingFromManifest, duplicated };
};

const gate = (update: boolean): number => {
  const manifest = readManifest();

  if (!update) {
    const { missingFromExpected, missingFromManifest, duplicated } = namesDisagree(
      manifest,
      readExpected(),
    );
    if (missingFromExpected.length > 0 || missingFromManifest.length > 0 || duplicated.length > 0) {
      console.log('\nmanifest.txt and expected.txt do not name the same tests:\n');
      for (const name of missingFromExpected) console.log(`  in manifest, unrecorded   ${name}`);
      for (const name of missingFromManifest) console.log(`  recorded, not in manifest ${name}`);
      for (const name of duplicated) console.log(`  listed twice in manifest  ${name}`);
      console.log('\nRe-run bogo:inventory if the scope moved, then bogo:record.\n');
      return 1;
    }
  }

  runBogo(['-test', manifest.join(';')]);
  const results = readResults();
  const decisions = decisionsByTest();

  const outcomes = manifest.map(name => ({
    name,
    actual: results.tests[name]?.actual ?? 'MISSING',
  }));
  const failed = outcomes.filter(o => o.actual === 'FAIL');
  const skipped = outcomes.filter(o => o.actual === 'SKIP');
  const missing = outcomes.filter(o => o.actual === 'MISSING');
  const passed = outcomes.length - failed.length - skipped.length - missing.length;

  console.log(`\nBoGo ${BORINGSSL_TAG} · ${manifest.length} in-scope tests\n`);
  console.log(`  PASS  ${passed}`);
  console.log(`  FAIL  ${failed.length}`);
  console.log(`  SKIP  ${skipped.length}   exit 89 — something the shim cannot do yet`);
  if (missing.length > 0) {
    console.log(
      `  GONE  ${missing.length}   in the manifest, not in the suite. Re-run bogo:inventory`,
    );
  }

  if (skipped.length > 0) {
    console.log('\nbacklog — what the shim declined, and what building it would unlock:\n');
    console.log(table(count(skipped, o => decisions.get(o.name)?.reason ?? 'unattributed')));
  }

  for (const [category, meaning] of CATEGORIES) {
    const inCategory = failed.filter(
      ({ name }) => categoryOf(results.tests[name]?.error ?? '') === category,
    );
    if (inCategory.length === 0) continue;
    console.log(`\n${category} (${inCategory.length}) — ${meaning}:\n`);
    for (const { name } of inCategory) {
      const error = results.tests[name]?.error ?? '';
      const ours = decisions.get(name)?.reason ?? 'accepted';
      console.log(`  ${name}\n      ours: ${ours}    want: ${wanted(error)}`);
    }
  }

  const milestone =
    skipped.length === 0 && failed.length === 0 && missing.length === 0
      ? 'M7: green — every in-scope test passes.'
      : `M7: ${passed}/${manifest.length}, ${skipped.length} still unbuilt.`;

  if (update) {
    if (failed.length > 0 || missing.length > 0) {
      console.log('\nrefusing to record a baseline while anything fails. Fix it, map it, or');
      console.log('declare it in scope.ts — a failure is not something to bless in a file.\n');
      return 1;
    }
    writeFileSync(
      EXPECTED,
      [
        '# What each in-scope BoGo test does today. The gate fails when any of it MOVES —',
        '# a regression and a fix both need a look, and a check that can never pass is a',
        `# check nobody reads. Regenerate with \`pnpm -F @yozz.app/tls bogo --update\`.`,
        `# boringssl ${BORINGSSL_TAG}: ${passed} pass, ${skipped.length} awaiting something the shim lacks.`,
        '',
        ...outcomes.map(o => `${o.actual} ${o.name}`),
        '',
      ].join('\n'),
    );
    console.log(`\nrecorded ${outcomes.length} outcomes -> harness/bogo/expected.txt`);
    console.log(`${milestone}\n`);
    return 0;
  }

  const expected = readExpected();
  const moved = outcomes.filter(o => expected.get(o.name) !== o.actual);
  if (moved.length > 0) {
    console.log('\nmoved since the last recorded run:\n');
    for (const { name, actual } of moved) {
      console.log(`  ${(expected.get(name) ?? 'NEW').padEnd(4)} -> ${actual.padEnd(7)} ${name}`);
    }
    console.log('\nA fix and a regression both land here. If this is a fix — or a pin bump —');
    console.log('re-record with `pnpm -F @yozz.app/tls bogo --update` and commit the diff.');
  }

  console.log(`\n${milestone}`);
  console.log(moved.length === 0 ? 'Nothing moved.\n' : 'Something moved.\n');
  return moved.length === 0 ? 0 : 1;
};

buildRunner();
if (process.argv.includes('--inventory')) {
  inventory();
} else {
  process.exit(gate(process.argv.includes('--update')));
}
