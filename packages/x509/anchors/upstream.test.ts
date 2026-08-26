/**
 * The gate ROADMAP asks for: **a simulated distrust producing a visible
 * failure.**
 *
 * A checker for an event that happens a few times a decade is a checker nobody
 * has ever seen fire, and one that silently stopped working would look exactly
 * like a quiet upstream. So the distrust is manufactured here — a synthetic
 * `certdata.txt` that retires a root the shipped bundle really contains — and
 * the diff has to say so.
 *
 * The inputs are built rather than fetched, so this needs no network and runs
 * in `pnpm test` beside everything else. The real fetch is
 * `anchors/upstream-check.ts`, which is the cron.
 */

import { describe, expect, it } from 'vitest';
import { pemFromDer } from '../harness/pem.ts';
import { ROOT_BUNDLE } from '../src/root-bundle-generated.ts';
import { diffTrustStore, subjectLabel } from './upstream.ts';

type Anchor = (typeof ROOT_BUNDLE)[number];

const bundlePem = (entries: readonly Anchor[]): string =>
  entries.map(entry => pemFromDer(entry.der)).join('');

const octal = (bytes: Uint8Array): string =>
  [...bytes].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');

/**
 * A `certdata.txt` fragment good enough for the parser, carrying one object per
 * root and optionally retiring one.
 *
 * The issuer and serial are SYNTHETIC, and that is not a shortcut. The parser
 * joins a cutoff to a certificate through the (issuer, serial) pair, so what the
 * fixture has to get right is that the pair AGREES between the two attributes on
 * an object — not that it matches the real certificate, which nothing here
 * reads. Deriving them from `subjectDer` keeps them distinct per root, which is
 * the only other property the join needs.
 */
const certdataFor = (
  entries: readonly Anchor[],
  retire: ReadonlyMap<string, string> = new Map(),
  { withTrustObjects = true }: { readonly withTrustObjects?: boolean } = {},
): string =>
  entries
    .flatMap(entry => {
      const identity = [
        `CKA_ISSUER MULTILINE_OCTAL\n${octal(entry.subjectDer)}\nEND`,
        `CKA_SERIAL_NUMBER MULTILINE_OCTAL\n${octal(entry.der.subarray(0, 8))}\nEND`,
      ];
      const certificate = [
        'CKA_CLASS CK_OBJECT_CLASS CKO_CERTIFICATE',
        `CKA_VALUE MULTILINE_OCTAL\n${octal(entry.der)}\nEND`,
        ...identity,
      ].join('\n');
      if (!withTrustObjects) return [certificate];

      /**
       * The trust object, written AFTER its certificate exactly as NSS does —
       * which is what makes the truncation case below reachable. The cutoff
       * lives here rather than on the certificate because that is where the one
       * shipped root that has one carries it.
       */
      const cutoff = retire.get(entry.id);
      const trust = [
        'CKA_CLASS CK_OBJECT_CLASS CKO_NSS_TRUST',
        ...identity,
        ...(cutoff === undefined
          ? []
          : [
              `CKA_NSS_SERVER_DISTRUST_AFTER MULTILINE_OCTAL\n${octal(
                new TextEncoder().encode(cutoff),
              )}\nEND`,
            ]),
      ].join('\n');
      return [certificate, trust];
    })
    .join('\n\n');

describe('the upstream trust-store diff', () => {
  const first = ROOT_BUNDLE[0];
  const second = ROOT_BUNDLE[1];
  if (first === undefined || second === undefined) {
    throw new Error('the shipped bundle has fewer than two roots');
  }
  const sample = [first, second];

  it('says nothing when upstream matches what we ship', () => {
    expect(
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor(sample),
      }),
    ).toEqual([]);
  });

  /**
   * **The gate.** A root that gains a cutoff is byte-for-byte the certificate we
   * already ship, so `cacert.pem` does not change and a hash comparison sees
   * nothing. This is the only check in the repo that would notice.
   */
  it('reports a root that upstream has retired, with the certificate unchanged', () => {
    const upstreamCacertPem = bundlePem(sample);
    const changes = diffTrustStore({
      shipped: sample,
      upstreamCacertPem,
      upstreamCertdata: certdataFor(sample, new Map([[second.id, '260415000000Z']])),
    });

    /**
     * The PEM is identical to what we SHIP — which is the whole point, and had
     * to stop comparing `upstreamCacertPem` to the expression that produced it.
     * A retirement moves no certificate bytes, so a hash comparison against the
     * shipped bundle sees nothing and only certdata knows.
     */
    expect(upstreamCacertPem).toBe(sample.map(entry => pemFromDer(entry.der)).join(''));
    expect(changes).toEqual([
      {
        kind: 'cutoff-changed',
        id: second.id,
        subject: subjectLabel(second.der),
        was: null,
        now: new Date('2026-04-15T00:00:00.000Z'),
        label: expect.any(String),
      },
    ]);
  });

  it('reports a root upstream has dropped', () => {
    expect(
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: bundlePem([first]),
        upstreamCertdata: certdataFor([first]),
      }),
    ).toEqual([{ kind: 'root-removed', id: second.id, subject: subjectLabel(second.der) }]);
  });

  it('reports a root upstream has added', () => {
    expect(
      diffTrustStore({
        shipped: [first],
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor(sample),
      }),
      // The label comes from the certificate's own subject, decoded — an added
      // root has no `subjectDer` beside it the way a shipped one does.
    ).toEqual([{ kind: 'root-added', subject: subjectLabel(second.der) }]);
  });

  /**
   * A failed fetch that returns an error page parses as zero certificates, and
   * a diff over zero certificates says every root we ship was removed. Reporting
   * 121 removals for a 502 would train a reader to ignore this job, which costs
   * more than the job is worth.
   */
  it('refuses an empty upstream rather than reporting a mass removal', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: '<html>502 Bad Gateway</html>',
        upstreamCertdata: '',
      }),
    ).toThrow(/yielded no certificates/);
  });

  /**
   * The false-NEGATIVE guard, and the reason it is not covered by the empty-PEM
   * test above: a short `certdata.txt` leaves `cacert.pem` completely intact, so
   * every root still matches and every cutoff reads as absent. That is the one
   * shape where this job would print "no change" over a retirement.
   */
  it('refuses a certdata that does not describe every root in the PEM', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        // Both roots still in the bundle, but certdata knows only one — a short
        // read, not a removal. A removal leaves the two files agreeing, which is
        // the case the test above this one covers.
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor([first]),
      }),
    ).toThrow(/no trust object/);
  });

  /**
   * The truncation the first version of this guard missed, and a review found.
   * NSS writes every `CKO_NSS_TRUST` after the `CKO_CERTIFICATE` it belongs to,
   * so a read that stops between the two blocks holds every certificate — the
   * weaker check called that complete — and no trust at all, which makes every
   * cutoff read as absent. `cacert.pem` is untouched in this case, so nothing
   * else in the job can see it.
   */
  it('refuses a certdata truncated before its trust objects', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor(sample, new Map(), { withTrustObjects: false }),
      }),
    ).toThrow(/no trust object/);
  });

  /**
   * `/[A-Za-z]{4}/` used to be the whole assertion, and a review pointed out
   * that `<unnamed, 908 bytes>` matches it — so a `subjectLabel` that had
   * stopped decoding entirely would have passed. Both real roots are named, and
   * the fallback shape is excluded by name.
   */
  it('names a root a human can recognise', () => {
    for (const entry of sample) {
      const label = subjectLabel(entry.der);
      expect(label).toMatch(/[A-Za-z]{4}/);
      expect(label).not.toMatch(/^<unnamed/);
    }
  });

  /**
   * A subject is attacker-chosen text going into a CI log, and `::error::` is a
   * GitHub Actions workflow COMMAND. A newline in a common name would start a
   * second line the runner obeys.
   */
  it('never lets a subject start a new line in the log', () => {
    const hostile = 'EvilCA\n::error::forged\u001b[31m';
    const label = subjectLabel(new TextEncoder().encode(hostile));
    expect(label).not.toContain('\n');
    expect(label).not.toContain('\u001b');
  });

  it('refuses a bundle that lists a root twice', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: bundlePem([first, second, second]),
        upstreamCertdata: certdataFor(sample),
      }),
    ).toThrow(/duplicate roots/);
  });
});
