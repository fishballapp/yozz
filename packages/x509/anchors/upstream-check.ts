/**
 * The cron: fetch what upstream publishes today, diff it against the trust
 * store we ship, and fail loudly when anything moved.
 *
 * **It reports rather than updates, and that is the design and not a shortcut.**
 * The obvious version bumps the pins, rebuilds the artifact and pushes — and
 * that hands whoever controls `curl.se` or the NSS mirror the ability to change
 * what YOZZ trusts, unattended, which is the exact thing `pin.ts` exists to
 * prevent. A trust store that changes without a human reading the diff is the
 * failure mode; automating the change is not a stronger version of the pin, it
 * is the pin removed. So this prints the diff, prints the two hashes ready to
 * paste, and exits non-zero. Shipping it is two commands and one read.
 *
 * `anchors:fetch` is the pinned fetch and is a different job: it verifies that
 * upstream still serves the bytes we pinned. This one asks what upstream serves
 * NOW, and never writes what it downloads anywhere.
 */

import { createHash } from 'node:crypto';
import { ROOT_BUNDLE } from '../src/root-bundle-generated.ts';
import { CACERT_URL } from './pin.ts';
import {
  describeChange,
  diffTrustStore,
  resolveCertdataCommit,
  UPSTREAM_CERTDATA_REF,
  upstreamCertdataUrl,
} from './upstream.ts';

const fetchText = async (url: string): Promise<{ text: string; sha256: string }> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`fetch failed: ${url} -> ${response.status} ${response.statusText}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    text: Buffer.from(bytes).toString('utf8'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

const cacert = await fetchText(CACERT_URL);
const certdata = await fetchText(upstreamCertdataUrl(UPSTREAM_CERTDATA_REF));

/**
 * Best effort, and the output says so when it fails. A rate-limited API must not
 * turn a real trust change into a job that reports nothing.
 */
const commit = await resolveCertdataCommit(async url => {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
});

const changes = diffTrustStore({
  shipped: ROOT_BUNDLE,
  upstreamCacertPem: cacert.text,
  upstreamCertdata: certdata.text,
});

if (changes.length === 0) {
  console.log(`upstream matches the shipped trust store — ${ROOT_BUNDLE.length} roots, no change`);
  process.exit(0);
}

/**
 * Cutoffs first. A root gaining one is a CA being retired while its
 * certificates stay in the bundle, which is both the most urgent kind of change
 * and the one no other check in this repo can see.
 */
const order = { 'cutoff-changed': 0, 'root-removed': 1, 'root-added': 2 } as const;
const sorted = [...changes].sort((a, b) => order[a.kind] - order[b.kind]);

console.error(`upstream has moved: ${changes.length} change(s) against the shipped trust store\n`);
for (const change of sorted) console.error(`  ${describeChange(change)}`);
console.error(
  [
    '',
    'Read what moved before shipping it. To ship:',
    '',
    '  1. anchors/pin.ts — paste all three:',
    `       CACERT_SHA256    = '${cacert.sha256}'`,
    `       CERTDATA_COMMIT  = '${commit ?? '<unresolved — see below>'}'`,
    `       CERTDATA_SHA256  = '${certdata.sha256}'`,
    '  2. pnpm -F @yozz.app/x509 anchors:fetch && pnpm -F @yozz.app/x509 anchors:build',
    '  3. commit src/root-bundle-generated.ts — the diff IS the trust change',
    '',
    ...(commit === null
      ? [
          'The commit did NOT resolve (GitHub API unreachable or rate-limited), and the hash',
          'above was read from the `master` branch. A hash without its ref is not a pin — find',
          'the commit that last touched lib/ckfw/builtins/certdata.txt before pasting it.',
        ]
      : [
          'CERTDATA_COMMIT is the commit that last touched certdata.txt, not the branch tip:',
          'pinning a tip makes every unrelated NSS commit read as a trust change.',
        ]),
  ].join('\n'),
);
process.exit(1);
