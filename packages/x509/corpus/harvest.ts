/**
 * Harvests the certificate corpus that M2 and M3 decode against.
 *
 * The corpus is HARVESTED, NOT AUTHORED — hand-written certificates encode what
 * we already believe a certificate looks like, which is exactly the belief the
 * decoder has to be tested against. These come off real mail servers, plus the
 * Mozilla root store Node ships.
 *
 * And it is deduplicated by what makes a certificate INTERESTING rather than by
 * count: signature algorithm, key type, extension set, and ASN.1 string and time
 * encoding. A hundred varied certificates beat a thousand near-identical ones,
 * and mail hosts share very few CAs between them — 215 harvested, 59 kept.
 *
 * Run it by hand, never in CI:
 *
 *     pnpm -F @yozz.app/x509 corpus:harvest
 *
 * The output is COMMITTED. A gate whose inputs are re-fetched every run tests
 * the internet as much as the decoder, and leaf certificates rotate every 90
 * days. Expiry does not matter here: M2 decodes DER and M3 diffs fields, and
 * neither checks time.
 */
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, rootCertificates } from 'node:tls';
import { promisify } from 'node:util';
import {
  CERTS_DIR,
  type CertificatePosition,
  MANIFEST_PATH,
  type Manifest,
  type Sighting,
} from './load.ts';

const run = promisify(execFile);

/**
 * The nine stage-3 mail servers, then widened across hosts to widen the CAs —
 * which is the axis that actually varies. Geography is a proxy for it: the
 * European, Chinese, Korean and Russian hosts are here because they do not all
 * buy from the same handful of issuers the US hosts do.
 *
 * Implicit-TLS ports only. STARTTLS would mean a protocol dialogue per port for
 * certificates that are, on every host checked, the same ones 993 serves.
 */
const TARGETS: readonly string[] = [
  // Stage 3's interop matrix — ARCHITECTURE.md.
  'imap.gmail.com:993',
  'imap.fastmail.com:993',
  'imap.forwardemail.net:993',
  'mail.gandi.net:993',
  'disroot.org:993',
  'imap.mailbox.org:993',
  'mail.riseup.net:993',
  'imap.migadu.com:993',
  'posteo.de:993',
  // Widening: other hosts, other CAs.
  'outlook.office365.com:993',
  'imap.mail.yahoo.com:993',
  'imap.aol.com:993',
  'imap.zoho.com:993',
  'imap.zoho.eu:993',
  'imap.mail.me.com:993',
  'imap.gmx.net:993',
  'imap.web.de:993',
  'imap.yandex.com:993',
  'imap.qq.com:993',
  'imap.163.com:993',
  'imap.naver.com:993',
  'imap.seznam.cz:993',
  'mail.infomaniak.com:993',
  'imap.ionos.de:993',
  'imap.one.com:993',
  'imap.purelymail.com:993',
  'imap.mail.ovh.net:993',
  'imap.rambler.ru:993',
  'imap.aruba.it:993',
  'imap.telstra.com:993',
  // Submission ports, in case a host splits its certificates by service.
  'smtp.gmail.com:465',
  'smtp.fastmail.com:465',
  'smtp.mailbox.org:465',
  'smtp.migadu.com:465',
];

/**
 * Node's bundled Mozilla store, which is the half of the harvest no mail server
 * can give us. **Servers rarely send their root** — only 2 of the 12 distinct
 * chain-top certificates above were self-signed — so without this the corpus
 * would hold almost no roots at all.
 *
 * It is also where the rare encodings live: of the 120 roots, exactly one dates
 * itself in `GeneralizedTime` and one carries an `IA5String` in its DN. Those
 * two are worth more to a decoder than another Let's Encrypt leaf.
 */
const ROOT_STORE_TARGET = 'node:root-store';

const CONNECT_TIMEOUT_MS = 10_000;
const HARVEST_CONCURRENCY = 8;
/** A chain longer than this is a server bug or a loop we failed to detect. */
const MAX_CHAIN_LENGTH = 10;

type HarvestedCertificate = {
  readonly certificate: X509Certificate;
  readonly target: string;
  readonly indexInChain: number;
  readonly chainLength: number;
};

/**
 * Walks the presented chain leaf-first. A root is its own issuer, so the
 * self-reference is the stop condition — without it the walk never terminates.
 *
 * `rejectUnauthorized: false` because a certificate we would reject is a
 * certificate worth decoding; this harvests bytes, it does not trust them.
 */
const fetchChain = (host: string, port: number): Promise<readonly X509Certificate[]> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const chain: X509Certificate[] = [];
      let cert = socket.getPeerX509Certificate();
      while (cert !== undefined) {
        chain.push(cert);
        const issuer = cert.issuerCertificate;
        if (issuer === undefined || issuer.raw.equals(cert.raw)) break;
        // Only the SELF-reference is caught above, so an A->B->A issuer cycle runs
        // until this cap. Rejecting sends the host to `unreachable` with a reason;
        // resolving here would record the truncation as real chain data.
        if (chain.length >= MAX_CHAIN_LENGTH) {
          socket.destroy();
          reject(
            new Error(`chain exceeded ${MAX_CHAIN_LENGTH} certificates - cycle or server bug`),
          );
          return;
        }
        cert = issuer;
      }
      socket.destroy();
      resolve(chain);
    });
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS}ms`));
    });
    socket.on('error', error => reject(error));
  });

/**
 * `AggregateError` is what a host with both A and AAAA records throws, and its
 * own message is the bare class name — the per-address codes are the reason.
 */
const describeFailure = (error: unknown): string => {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(cause =>
      cause instanceof Error ? cause.message : String(cause),
    );
    return causes.length === 0 ? 'AggregateError' : [...new Set(causes)].join('; ');
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
};

/**
 * Self-signed FIRST, and deliberately so. Calling the last certificate in a
 * presented chain the "root" is wrong on most of the web: servers send a leaf
 * plus intermediates and leave the client to supply the root, so that last
 * certificate is usually an intermediate. Only a signature over its own key
 * makes something a root — measured across the 34 hosts here, 10 of the 12
 * distinct chain-top certificates were not roots at all.
 */
const positionOf = (harvested: HarvestedCertificate): CertificatePosition => {
  // A root store holds roots by definition. Falling through would file a root
  // whose signature this Node cannot verify as a `leaf`, which it never is.
  if (harvested.target === ROOT_STORE_TARGET) return 'root';
  try {
    if (harvested.certificate.verify(harvested.certificate.publicKey)) return 'root';
  } catch {
    // An algorithm this Node cannot verify is not thereby a root.
  }
  return harvested.indexInChain === 0 ? 'leaf' : 'intermediate';
};

/** `rsa/2048`, `ec/prime256v1`, `ed25519`. */
const keyDescriptionOf = (certificate: X509Certificate): string => {
  const { asymmetricKeyType, asymmetricKeyDetails } = certificate.publicKey;
  const size = asymmetricKeyDetails?.modulusLength ?? asymmetricKeyDetails?.namedCurve;
  return size === undefined ? (asymmetricKeyType ?? 'unknown') : `${asymmetricKeyType}/${size}`;
};

/**
 * The ASN.1 string and time types actually used. `openssl x509 -text` shows
 * NEITHER — it normalises both away — which is why this reads `asn1parse`
 * instead, and why "decodes against -text" is not on its own a strict-DER test.
 *
 * ponytail: top-level TLVs only, so IA5Strings nested inside the SAN's OCTET
 * STRING do not appear. Subject/issuer names and the validity times are what
 * vary between issuers, and they are all at this level.
 */
const ASN1_ENCODING_TYPES =
  /\b(UTCTIME|GENERALIZEDTIME|PRINTABLESTRING|UTF8STRING|IA5STRING|BMPSTRING|T61STRING|VISIBLESTRING|NUMERICSTRING|UNIVERSALSTRING)\b/g;

/**
 * Extension headers, scoped to the extensions block rather than found by indent
 * alone. The scoping is what makes the pattern safe to loosen: `Not Before`,
 * `Not After` and `Public Key Algorithm` print at the same 12 spaces OUTSIDE
 * the block, while an extension OpenSSL has no name for prints as a bare OID —
 * and a pattern loose enough to catch that OID would swallow those three.
 */
const EXTENSIONS_BLOCK = /^ {8}X509v3 extensions:\n([\s\S]*?)\n {4}Signature Algorithm:/m;
const EXTENSION_HEADER = /^ {12}(\S[^:\n]*?):( critical)?[ \t]*$/gm;

const extensionsOf = (text: string, describe: string): string[] => {
  const block = EXTENSIONS_BLOCK.exec(text)?.[1];
  // A v1 certificate carries no extensions; anything else means OpenSSL's output
  // moved under us, and silently returning [] would read as a v1 certificate.
  if (block === undefined) {
    if (text.includes('X509v3 extensions')) {
      throw new Error(`could not delimit the extensions block for ${describe}`);
    }
    return [];
  }
  return [...block.matchAll(EXTENSION_HEADER)]
    .map(match => `${match[1]}${match[2] === undefined ? '' : '!critical'}`)
    .sort();
};

/**
 * RSASSA-PSS carries its hash, MGF and salt length in the AlgorithmIdentifier's
 * PARAMETERS, and OpenSSL prints them on CONTINUATION lines under a bare
 * `Signature Algorithm: rsassaPss`. Reading only the header line fingerprints
 * PSS-SHA256 and PSS-SHA512 identically, so one of them is deduplicated away —
 * losing the non-NULL-parameters case M3 exists to get right.
 *
 * No certificate in today's corpus is PSS. This is here so the next re-harvest
 * does not quietly drop the first one that is.
 */
const SIGNATURE_ALGORITHM = /^\s*Signature Algorithm: (.+)$/m;
const ALGORITHM_PARAMETERS = /^\s*(Hash Algorithm|Mask Algorithm|Salt Length): (.+)$/gm;

const signatureAlgorithmOf = (text: string, describe: string): string => {
  const name = SIGNATURE_ALGORITHM.exec(text)?.[1]?.trim();
  if (name === undefined) {
    throw new Error(`no signature algorithm in openssl output for ${describe}`);
  }
  // Deduplicated because -text prints the AlgorithmIdentifier twice, inner and outer.
  const parameters = [
    ...new Set([...text.matchAll(ALGORITHM_PARAMETERS)].map(m => `${m[1]}=${m[2]?.trim()}`)),
  ];
  return parameters.length === 0 ? name : `${name}(${parameters.join(', ')})`;
};

const fingerprintOf = async (
  derPath: string,
  certificate: X509Certificate,
  /** Names the certificate in an error — `derPath` is one reused scratch file. */
  describe: string,
): Promise<Manifest['certificates'][number]['fingerprint']> => {
  const [{ stdout: text }, { stdout: asn1 }] = await Promise.all([
    run('openssl', ['x509', '-inform', 'DER', '-in', derPath, '-noout', '-text']),
    run('openssl', ['asn1parse', '-inform', 'DER', '-in', derPath]),
  ]);

  return {
    signatureAlgorithm: signatureAlgorithmOf(text, describe),
    key: keyDescriptionOf(certificate),
    extensions: extensionsOf(text, describe),
    asn1Types: [...new Set(asn1.match(ASN1_ENCODING_TYPES) ?? [])].sort(),
  };
};

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

const harvests = await mapWithConcurrency(TARGETS, HARVEST_CONCURRENCY, async target => {
  const [host = '', port = ''] = target.split(':');
  try {
    const chain = await fetchChain(host, Number(port));
    if (chain.length === 0) throw new Error('connected but presented no certificate');
    console.log(`  ${target.padEnd(28)} ${chain.length} certificates`);
    return { target, chain };
  } catch (error) {
    const message = describeFailure(error);
    console.log(`  ${target.padEnd(28)} FAILED: ${message}`);
    return { target, failure: message };
  }
});

const fromChains = harvests.flatMap(({ target, chain }) =>
  chain === undefined
    ? []
    : chain.map(
        (certificate, indexInChain): HarvestedCertificate => ({
          certificate,
          target,
          indexInChain,
          chainLength: chain.length,
        }),
      ),
);
const fromRootStore = rootCertificates.map(
  (pem): HarvestedCertificate => ({
    certificate: new X509Certificate(pem),
    target: ROOT_STORE_TARGET,
    indexInChain: 0,
    chainLength: 1,
  }),
);
console.log(`  ${ROOT_STORE_TARGET.padEnd(28)} ${fromRootStore.length} certificates`);
const reached = [...fromChains, ...fromRootStore];

// Recorded, not silently dropped: an unreachable host is why some CA is missing.
const unreachable = harvests.flatMap(({ target, failure }) =>
  failure === undefined ? [] : [{ target, reason: failure }],
);

const scratch = await mkdtemp(join(tmpdir(), 'yozz-corpus-'));
const entries = new Map<string, { entry: Manifest['certificates'][number]; der: Buffer }>();
try {
  for (const harvested of reached) {
    const derPath = join(scratch, 'certificate.der');
    await writeFile(derPath, harvested.certificate.raw);
    const sha256 = harvested.certificate.fingerprint256.replaceAll(':', '').toLowerCase();
    const subject = harvested.certificate.subject.replaceAll('\n', ', ');
    const fingerprint = await fingerprintOf(
      derPath,
      harvested.certificate,
      `${subject} (${sha256})`,
    );

    // The sighting carries its OWN hash, because deduplication is by fingerprint
    // and the certificate collapsing into an entry is often not that entry's
    // bytes. Without this the manifest asserts, say, that rambler.ru served
    // DigiCert Global Root G2 — it serves GlobalSign Root CA R3.
    const sighting: Sighting = {
      target: harvested.target,
      indexInChain: harvested.indexInChain,
      chainLength: harvested.chainLength,
      position: positionOf(harvested),
      sha256,
    };

    const key = JSON.stringify(fingerprint);
    const existing = entries.get(key);
    if (existing !== undefined) {
      existing.entry.seenAt.push(sighting);
      continue;
    }
    entries.set(key, {
      der: harvested.certificate.raw,
      entry: {
        // The hash is in the name because the root store contributes 120
        // certificates under one target, and a name has to be unique without it.
        file: `${harvested.target.replaceAll(':', '-')}-${sha256.slice(0, 8)}-${sighting.position}.der`,
        sha256,
        subject,
        fingerprint,
        seenAt: [sighting],
      },
    });
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

const kept = [...entries.values()].sort((a, b) => a.entry.file.localeCompare(b.entry.file));
if (new Set(kept.map(({ entry }) => entry.file)).size !== kept.length) {
  throw new Error('two certificates want the same filename');
}

await rm(CERTS_DIR, { recursive: true, force: true });
await mkdir(CERTS_DIR, { recursive: true });
for (const { entry, der } of kept) await writeFile(join(CERTS_DIR, entry.file), der);

const manifest: Manifest = { version: 1, unreachable, certificates: kept.map(k => k.entry) };
await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

const absorbed = kept.filter(({ entry }) =>
  entry.seenAt.some(sighting => sighting.sha256 !== entry.sha256),
).length;
console.log(`\n${reached.length} certificates from ${TARGETS.length - unreachable.length} hosts`);
console.log(`${kept.length} kept, ${reached.length - kept.length} deduplicated`);
console.log(`${absorbed} entries stand in for certificates whose bytes are NOT stored`);
console.log(`${unreachable.length} hosts unreachable`);
console.log(`\nwrote ${MANIFEST_PATH}`);
