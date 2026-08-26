/**
 * What upstream has done to the trust store since we pinned it.
 *
 * The pins in `pin.ts` freeze two files by hash, which is what stops a trust
 * store changing without a diff to read. The cost of freezing is that it also
 * stops the trust store changing when it SHOULD: a CA distrusted this morning
 * is still trusted by a client shipping last month's pin, and nothing in the
 * build says so. This module is the other half — it compares the artifact we
 * ship against what upstream publishes today, and names what moved.
 *
 * **Three kinds of movement, and the third is the reason this exists.** A root
 * ADDED and a root REMOVED are both visible in `cacert.pem` and a hash mismatch
 * would catch them. A root that GAINED A CUTOFF is not: the certificate is
 * byte-for-byte identical, so the PEM does not change at all, and only
 * `certdata.txt` knows. That is the case the shipped bundle already has one of
 * (`Izenpe.com`), and the case a bundle-only diff misses completely.
 *
 * The comparison is a pure function over bytes so the gate can hand it a
 * SIMULATED distrust — see `upstream.test.ts`. A checker that can only be
 * exercised by waiting for a real CA to be retired is a checker nobody has ever
 * seen work.
 */

import { derFromPem } from '../harness/pem.ts';
import type { AnchorIndexEntry } from '../src/anchors.ts';
import { decodeCertificate } from '../src/certificate.ts';
import { derKey, serverDistrustByCertificate, trustedCertificateDerKeys } from './certdata.ts';

/**
 * A moving ref on purpose, and the one place in this package that has one.
 *
 * `pin.ts` takes `certdata.txt` by COMMIT because a moving trust input is what
 * pinning exists to prevent. This job wants the opposite: its entire question is
 * "what does upstream say TODAY", and a pinned answer to that is no answer. The
 * bytes it fetches are never compiled into anything — they are read, compared
 * and thrown away.
 */
export const UPSTREAM_CERTDATA_REF = 'master';
export const UPSTREAM_CERTDATA_PATH = 'lib/ckfw/builtins/certdata.txt';
export const upstreamCertdataUrl = (ref: string): string =>
  `https://raw.githubusercontent.com/nss-dev/nss/${ref}/${UPSTREAM_CERTDATA_PATH}`;

/**
 * What `master` points at right now, because a hash without its ref is not a
 * pin and the failure output says so in as many words.
 *
 * A review caught this printing `CERTDATA_SHA256` beside an instruction to bump
 * `CERTDATA_COMMIT` "to the ref you read", with no ref anywhere in the log —
 * true advice the output could not be used to follow. Resolving it costs one
 * more request. **Resolved for the PATH, not the branch tip**: certdata.txt
 * changes far less often than NSS does, so the commit that last touched the file
 * is the one worth pinning, and pinning a branch tip that merely happens to
 * contain it makes every unrelated NSS commit look like a trust change.
 */
export const resolveCertdataCommit = async (
  fetchJson: (url: string) => Promise<unknown>,
): Promise<string | null> => {
  const body = await fetchJson(
    `https://api.github.com/repos/nss-dev/nss/commits?sha=${UPSTREAM_CERTDATA_REF}` +
      `&path=${UPSTREAM_CERTDATA_PATH}&per_page=1`,
  ).catch(() => null);
  if (!Array.isArray(body)) return null;
  const sha = (body[0] as { sha?: unknown } | undefined)?.sha;
  return typeof sha === 'string' ? sha : null;
};

export type TrustStoreChange =
  | { readonly kind: 'root-added'; readonly subject: string }
  | { readonly kind: 'root-removed'; readonly id: string; readonly subject: string }
  | {
      readonly kind: 'cutoff-changed';
      readonly id: string;
      readonly subject: string;
      /** `null` when the root carried no cutoff before, which is the usual case. */
      readonly was: Date | null;
      readonly now: Date | null;
      readonly label: string;
    };

/**
 * WHICH root moved, for a human reading a failed cron.
 *
 * The common name, which is what a CA is called everywhere else — root
 * programs, browser UI, the news story about a distrust. It takes the whole
 * CERTIFICATE rather than the `subjectDer` beside it in the artifact, because a
 * root upstream has ADDED has no artifact entry to take a subject from, and one
 * function covering both cases is one behaviour to read.
 *
 * The value TLV is kept verbatim by the decoder (RFC 5280 name comparison turns
 * on the string type), so the text is that TLV minus its two header bytes,
 * decoded as UTF-8: exact for `UTF8String`, and `PrintableString` is ASCII.
 *
 * Falling back to the printable runs of the raw bytes is not decoration. A root
 * with no common name, or one this decoder chokes on, is still a root that
 * moved, and a report that dropped it would be worse than one that names it
 * badly.
 */
const COMMON_NAME_OID = '2.5.4.3';

/**
 * A certificate subject is attacker-chosen text on its way into a CI log, and
 * this job's whole premise is that upstream might do something we did not
 * expect. A review demonstrated the consequence: a common name of
 * `EvilCA\n::error::forged trust change` becomes a second line in the GitHub
 * Actions log, and `::error::` is a workflow COMMAND — so a hostile root could
 * forge or bury the very report that is supposed to catch it. ANSI escapes do
 * the same to a terminal.
 *
 * So: no control characters, no escapes, and a length cap. A CA name is a
 * label here, never a value anything parses, so mangling a pathological one
 * costs nothing and the alternative is a log that lies.
 */
const MAX_LABEL_CHARACTERS = 120;

const printable = (text: string): string => {
  const stripped = [...text.trim()]
    .map(character =>
      (character.codePointAt(0) ?? 0) < 0x20 || character === '\u007f' ? ' ' : character,
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > MAX_LABEL_CHARACTERS
    ? `${stripped.slice(0, MAX_LABEL_CHARACTERS)}…`
    : stripped;
};

export const subjectLabel = (certificateDer: Uint8Array): string => {
  try {
    const attributes = decodeCertificate(certificateDer).subject.relativeDistinguishedNames.flat();
    const commonName = attributes.find(attribute => attribute.oid === COMMON_NAME_OID);
    if (commonName !== undefined) {
      const text = printable(new TextDecoder().decode(commonName.valueDer.subarray(2)));
      if (text.length > 0) return text;
    }
  } catch {
    // Fall through: an undecodable root is still a root that moved.
  }
  const runs = [...certificateDer]
    .map(byte => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' '))
    .join('')
    .split(' ')
    .filter(run => run.length >= 6);
  return runs.length === 0
    ? `<unnamed, ${certificateDer.length} bytes>`
    : printable(runs.slice(0, 3).join(' / '));
};

/**
 * What upstream would compile to, against what we ship.
 *
 * Matching is by certificate DER, not by `id`: the ids are positional
 * (`cacert.pem#37`), so one root leaving the bundle renumbers every root after
 * it and an id-keyed diff would report 84 changes for one removal.
 */
export const diffTrustStore = ({
  shipped,
  upstreamCacertPem,
  upstreamCertdata,
}: {
  readonly shipped: readonly AnchorIndexEntry[];
  readonly upstreamCacertPem: string;
  readonly upstreamCertdata: string;
}): readonly TrustStoreChange[] => {
  const upstreamRoots = derFromPem(upstreamCacertPem);
  if (upstreamRoots.length === 0) {
    throw new Error(
      'upstream cacert.pem yielded no certificates. Refusing to report 121 removals from what ' +
        'is almost certainly a failed fetch or an error page.',
    );
  }
  /**
   * The one way this diff could report a FALSE "no change", and it is the
   * dangerous direction. A root that GAINS a cutoff is detected by finding that
   * cutoff in `certdata.txt` — so a certdata that fetched short, or came back as
   * something that parses to nothing, yields no cutoff, compares equal to the
   * `null` we ship, and the retirement passes in silence. The PEM guard above
   * cannot see it: `cacert.pem` is unchanged in exactly that case, which is the
   * whole reason this second file is fetched at all.
   *
   * The check is `build.ts`'s, applied to the upstream pair rather than the
   * pinned one: **every root in the PEM must be described by the certdata beside
   * it.** That is exact rather than a threshold — a root genuinely REMOVED from
   * NSS leaves both files together and is reported as a removal, while a short
   * read leaves roots in the PEM that certdata cannot account for, and those are
   * precisely the roots whose cutoffs would be read as absent.
   *
   * **Described means it has a TRUST object, not merely a certificate one**, and
   * a review is why. A cutoff usually hangs off `CKO_NSS_TRUST`, and NSS writes
   * those after the `CKO_CERTIFICATE` they belong to — so a file truncated
   * between the two blocks holds every certificate and no trust at all, which
   * the weaker check called complete while every cutoff read as absent. Measured
   * on the real file: 172 certificates, 172 with a trust object, so the stricter
   * demand costs nothing on a good read.
   */
  const described = trustedCertificateDerKeys(upstreamCertdata);
  const undescribed = upstreamRoots.filter(der => !described.has(derKey(der)));
  if (undescribed.length > 0) {
    throw new Error(
      `${undescribed.length} of ${upstreamRoots.length} upstream roots have no trust object in ` +
        'upstream certdata.txt. The two files disagree, so every cutoff read from it is ' +
        'unreliable — and an unread cutoff compares equal to having none. Refusing to call ' +
        'that "no change".',
    );
  }
  const upstreamDistrust = serverDistrustByCertificate(upstreamCertdata);
  const upstreamByDer = new Map(upstreamRoots.map(der => [derKey(der), der] as const));
  const shippedByDer = new Map(shipped.map(entry => [derKey(entry.der), entry] as const));

  /**
   * Both sides are keyed by DER, so a root appearing TWICE collapses and the
   * per-root walk below sees nothing — a review's finding, and the consequence
   * is not academic: `anchors:build` indexes positionally, so a duplicated root
   * upstream produces an artifact with one more entry while this job reports
   * "no change". Comparing the counts costs two numbers and closes it.
   */
  if (upstreamRoots.length !== upstreamByDer.size || shipped.length !== shippedByDer.size) {
    throw new Error(
      `duplicate roots: upstream has ${upstreamRoots.length} certificates for ` +
        `${upstreamByDer.size} distinct, shipped has ${shipped.length} for ${shippedByDer.size}. ` +
        'A DER-keyed diff cannot see multiplicity, so this needs a human rather than a verdict.',
    );
  }

  const changes: TrustStoreChange[] = [];

  for (const entry of shipped) {
    const key = derKey(entry.der);
    const subject = subjectLabel(entry.der);
    if (!upstreamByDer.has(key)) {
      changes.push({ kind: 'root-removed', id: entry.id, subject });
      continue;
    }
    const now = upstreamDistrust.get(key);
    /**
     * The invisible one. Both sides hold the same certificate, so nothing about
     * the PEM has moved; what changed is what NSS says that certificate may
     * still vouch for.
     */
    if ((now?.notAfter ?? null)?.getTime() !== (entry.serverDistrustAfter ?? null)?.getTime()) {
      changes.push({
        kind: 'cutoff-changed',
        id: entry.id,
        subject,
        was: entry.serverDistrustAfter,
        now: now?.notAfter ?? null,
        label: now?.label ?? 'none',
      });
    }
  }

  for (const [key, der] of upstreamByDer) {
    if (!shippedByDer.has(key)) {
      changes.push({ kind: 'root-added', subject: subjectLabel(der) });
    }
  }

  return changes;
};

/** One line per change, for a cron log a human reads once and acts on. */
export const describeChange = (change: TrustStoreChange): string => {
  const iso = (date: Date | null): string => (date === null ? 'none' : date.toISOString());
  switch (change.kind) {
    case 'root-added':
      return `ADDED    ${change.subject}`;
    case 'root-removed':
      return `REMOVED  ${change.id}  ${change.subject}`;
    case 'cutoff-changed': {
      // NSS's own `CKA_LABEL` when it has one, and nothing rather than empty
      // parentheses when it does not — this is read by a person once.
      const label = change.label === '' || change.label === 'none' ? '' : `  (${change.label})`;
      return `CUTOFF   ${change.id}  ${change.subject}\n           ${iso(change.was)} -> ${iso(
        change.now,
      )}${label}`;
    }
  }
};
