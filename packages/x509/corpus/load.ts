/** The shape lives here so the harvester and every consumer agree. Zod checks shape; `loadManifest` guards integrity. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const HERE = new URL('.', import.meta.url).pathname;
export const CERTS_DIR = join(HERE, 'certs');
/** `.gen.` is the repo's generated-file marker, and what keeps Biome off it. */
export const MANIFEST_PATH = join(HERE, 'manifest.gen.json');

/** Where a certificate sat in the chain that presented it. `root` means self-signed. */
export const POSITIONS = ['leaf', 'intermediate', 'root'] as const;
export type CertificatePosition = (typeof POSITIONS)[number];

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'not a lowercase hex SHA-256');

/**
 * What deduplicates a certificate. Chain position is not here: it is a property of the chain, and
 * folding it in stores one cross-signed root twice.
 */
const FingerprintSchema = z.object({
  signatureAlgorithm: z.string(),
  /** `rsa/2048`, `ec/prime256v1`, `ed25519`. */
  key: z.string(),
  /** Sorted extension names, `!critical` appended where the extension is. */
  extensions: z.array(z.string()),
  /** Sorted ASN.1 string and time types, which `openssl x509 -text` hides. */
  asn1Types: z.array(z.string()),
});

/**
 * A sighting of this entry's FINGERPRINT, not necessarily its bytes: a sighting is provenance only
 * when its `sha256` equals the entry's.
 */
const SightingSchema = z.object({
  target: z.string(),
  indexInChain: z.number().int().nonnegative(),
  chainLength: z.number().int().positive(),
  position: z.enum(POSITIONS),
  sha256: Sha256Schema,
});

const ManifestSchema = z.object({
  version: z.literal(1),
  /** Kept so a missing CA reads as an unreachable host, not as a harvest bug. */
  unreachable: z.array(z.object({ target: z.string(), reason: z.string() })),
  certificates: z.array(
    z.object({
      file: z.string(),
      sha256: Sha256Schema,
      subject: z.string(),
      fingerprint: FingerprintSchema,
      seenAt: z.array(SightingSchema).nonempty(),
    }),
  ),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Sighting = z.infer<typeof SightingSchema>;
export type CorpusCertificate = Manifest['certificates'][number] & { readonly der: Uint8Array };

/** Only high enough that an emptied corpus cannot pass; the diversity floors in `corpus.test.ts` are the real bound. */
const MINIMUM_CERTIFICATES = 20;

export const loadManifest = async (): Promise<Manifest> => {
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
  if (manifest.certificates.length < MINIMUM_CERTIFICATES) {
    throw new Error(
      `corpus holds ${manifest.certificates.length} certificates, under the ${MINIMUM_CERTIFICATES} floor. ` +
        'Re-run `pnpm -F @yozz.app/x509 corpus:harvest`.',
    );
  }
  if (
    new Set(manifest.certificates.map(entry => entry.file)).size !== manifest.certificates.length
  ) {
    throw new Error('two manifest entries name the same file');
  }
  return manifest;
};

/** The sightings that are actually this certificate, rather than one it absorbed. */
export const provenanceOf = (entry: Manifest['certificates'][number]): readonly Sighting[] =>
  entry.seenAt.filter(sighting => sighting.sha256 === entry.sha256);

export const loadCorpus = async (): Promise<readonly CorpusCertificate[]> => {
  const manifest = await loadManifest();
  return Promise.all(
    manifest.certificates.map(async entry => ({
      ...entry,
      der: new Uint8Array(await readFile(join(CERTS_DIR, entry.file))),
    })),
  );
};
