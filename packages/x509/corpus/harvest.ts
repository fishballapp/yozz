/**
 * Harvests the certificate corpus off real mail servers plus Node's Mozilla root store, deduplicated
 * by signature algorithm, key type, extension set and ASN.1 string/time encoding. The output is
 * committed. Run by hand: `pnpm -F @yozz.app/x509 corpus:harvest`.
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

/** Widened across geographies to widen the CAs. Implicit-TLS ports only. */
const TARGETS: readonly string[] = [
  'imap.gmail.com:993',
  'imap.fastmail.com:993',
  'imap.forwardemail.net:993',
  'mail.gandi.net:993',
  'disroot.org:993',
  'imap.mailbox.org:993',
  'mail.riseup.net:993',
  'imap.migadu.com:993',
  'posteo.de:993',
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
  'smtp.gmail.com:465',
  'smtp.fastmail.com:465',
  'smtp.mailbox.org:465',
  'smtp.migadu.com:465',
];

/** Servers rarely send their root (2 of 12 chain tops here were self-signed), and the rare encodings live in the root store. */
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

/** Leaf-first; a root is its own issuer, which is the stop. `rejectUnauthorized: false` because this harvests bytes, it does not trust them. */
const fetchChain = (host: string, port: number): Promise<readonly X509Certificate[]> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
      const chain: X509Certificate[] = [];
      let cert = socket.getPeerX509Certificate();
      while (cert !== undefined) {
        chain.push(cert);
        const issuer = cert.issuerCertificate;
        if (issuer === undefined || issuer.raw.equals(cert.raw)) break;
        // An A->B->A cycle runs until this cap; rejecting sends the host to `unreachable`.
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

/** `AggregateError` is what a host with both A and AAAA throws, and its message is the bare class name. */
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

/** Self-signed first: the last certificate in a presented chain is usually an intermediate, not a root. */
const positionOf = (harvested: HarvestedCertificate): CertificatePosition => {
  // A root store holds roots by definition, even ones this Node cannot verify.
  if (harvested.target === ROOT_STORE_TARGET) return 'root';
  try {
    if (harvested.certificate.verify(harvested.certificate.publicKey)) return 'root';
  } catch {}
  return harvested.indexInChain === 0 ? 'leaf' : 'intermediate';
};

/** `rsa/2048`, `ec/prime256v1`, `ed25519`. */
const keyDescriptionOf = (certificate: X509Certificate): string => {
  const { asymmetricKeyType, asymmetricKeyDetails } = certificate.publicKey;
  const size = asymmetricKeyDetails?.modulusLength ?? asymmetricKeyDetails?.namedCurve;
  return size === undefined ? (asymmetricKeyType ?? 'unknown') : `${asymmetricKeyType}/${size}`;
};

/** `openssl x509 -text` normalises string and time types away, so this reads `asn1parse`. Top-level TLVs only. */
const ASN1_ENCODING_TYPES =
  /\b(UTCTIME|GENERALIZEDTIME|PRINTABLESTRING|UTF8STRING|IA5STRING|BMPSTRING|T61STRING|VISIBLESTRING|NUMERICSTRING|UNIVERSALSTRING)\b/g;

/** Scoped to the extensions block: `Not Before` and `Public Key Algorithm` print at the same indent outside it. */
const EXTENSIONS_BLOCK = /^ {8}X509v3 extensions:\n([\s\S]*?)\n {4}Signature Algorithm:/m;
const EXTENSION_HEADER = /^ {12}(\S[^:\n]*?):( critical)?[ \t]*$/gm;

const extensionsOf = (text: string, describe: string): string[] => {
  const block = EXTENSIONS_BLOCK.exec(text)?.[1];
  // A v1 certificate carries no extensions; anything else means OpenSSL's output moved.
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

/** RSASSA-PSS carries its hash in the parameters, printed on continuation lines; without them PSS-SHA256 and PSS-SHA512 fingerprint identically. */
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

    // The sighting carries its own hash: deduplication is by fingerprint, and the collapsed certificate is often not this entry's bytes.
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
        // The root store contributes 120 certificates under one target, so the name needs the hash.
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
