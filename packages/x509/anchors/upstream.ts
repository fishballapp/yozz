/**
 * What upstream has done to the trust store since the pin. A root added or removed shows in
 * `cacert.pem`; a root that gained a cutoff does not, and only `certdata.txt` knows. Pure over bytes
 * so the test can hand it a simulated distrust.
 */

import { derFromPem } from '../harness/pem.ts';
import type { AnchorIndexEntry } from '../src/anchors.ts';
import { decodeCertificate } from '../src/certificate.ts';
import { derKey, serverDistrustByCertificate, trustedCertificateDerKeys } from './certdata.ts';

/** A moving ref on purpose: the question is what upstream says today, and the bytes are never compiled. */
export const UPSTREAM_CERTDATA_REF = 'master';
export const UPSTREAM_CERTDATA_PATH = 'lib/ckfw/builtins/certdata.txt';
export const upstreamCertdataUrl = (ref: string): string =>
  `https://raw.githubusercontent.com/nss-dev/nss/${ref}/${UPSTREAM_CERTDATA_PATH}`;

/** Resolved for the path, not the branch tip: certdata.txt changes far less often than NSS. */
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

/** The common name, from the whole certificate (an added root has no artifact entry), with a raw-bytes fallback. */
const COMMON_NAME_OID = '2.5.4.3';

/** A subject is attacker-chosen text going into a CI log, where `::error::` is a workflow command. */
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

/** Matched by certificate DER, not by positional `id`. */
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
   * Every root in the PEM must have a trust object in the certdata beside it. A short certdata read
   * leaves the PEM intact and every cutoff reading as absent, which is the one false "no change".
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

  /** Both sides are keyed by DER, so a duplicated root upstream would otherwise collapse. */
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
    // Same certificate on both sides; only what NSS says it may vouch for changed.
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
      const label = change.label === '' || change.label === 'none' ? '' : `  (${change.label})`;
      return `CUTOFF   ${change.id}  ${change.subject}\n           ${iso(change.was)} -> ${iso(
        change.now,
      )}${label}`;
    }
  }
};
