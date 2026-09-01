/** A simulated distrust must produce a visible failure: a synthetic `certdata.txt` retires a root the shipped bundle contains. */

import { describe, expect, it } from 'vitest';
import { pemFromDer } from '../harness/pem.ts';
import { ROOT_BUNDLE } from '../src/root-bundle-generated.ts';
import { diffTrustStore, subjectLabel } from './upstream.ts';

type Anchor = (typeof ROOT_BUNDLE)[number];

const bundlePem = (entries: readonly Anchor[]): string =>
  entries.map(entry => pemFromDer(entry.der)).join('');

const octal = (bytes: Uint8Array): string =>
  [...bytes].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');

/** Issuer and serial are synthetic: the join only needs the pair to agree between the two attributes on an object. */
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

      // The trust object after its certificate, as NSS writes them, so the truncation case is reachable.
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

  /** The gate: a root gaining a cutoff leaves `cacert.pem` byte-identical. */
  it('reports a root that upstream has retired, with the certificate unchanged', () => {
    const upstreamCacertPem = bundlePem(sample);
    const changes = diffTrustStore({
      shipped: sample,
      upstreamCacertPem,
      upstreamCertdata: certdataFor(sample, new Map([[second.id, '260415000000Z']])),
    });

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

  /** An error page parses as zero certificates; reporting 121 removals for a 502 would train readers to ignore the job. */
  it('refuses an empty upstream rather than reporting a mass removal', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: '<html>502 Bad Gateway</html>',
        upstreamCertdata: '',
      }),
    ).toThrow(/yielded no certificates/);
  });

  /** A short `certdata.txt` leaves `cacert.pem` intact and every cutoff reading as absent. */
  it('refuses a certdata that does not describe every root in the PEM', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        // Both roots in the bundle, certdata knows one: a short read, not a removal.
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor([first]),
      }),
    ).toThrow(/no trust object/);
  });

  /** NSS writes every `CKO_NSS_TRUST` after the `CKO_CERTIFICATE` it belongs to, so a read stopping between them has no trust at all. */
  it('refuses a certdata truncated before its trust objects', () => {
    expect(() =>
      diffTrustStore({
        shipped: sample,
        upstreamCacertPem: bundlePem(sample),
        upstreamCertdata: certdataFor(sample, new Map(), { withTrustObjects: false }),
      }),
    ).toThrow(/no trust object/);
  });

  /** `<unnamed, 908 bytes>` matches `/[A-Za-z]{4}/`, so the fallback shape is excluded by name. */
  it('names a root a human can recognise', () => {
    for (const entry of sample) {
      const label = subjectLabel(entry.der);
      expect(label).toMatch(/[A-Za-z]{4}/);
      expect(label).not.toMatch(/^<unnamed/);
    }
  });

  /** `::error::` is a GitHub Actions workflow command; a newline in a common name would start one. */
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
