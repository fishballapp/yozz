/** Guards the corpus itself: a corpus that silently shrinks still passes a decoder gate. No network, no openssl. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CorpusCertificate,
  loadCorpus,
  loadManifest,
  POSITIONS,
  provenanceOf,
} from './load.ts';

const corpus = await loadCorpus();

const distinct = (values: readonly string[]): number => new Set(values).size;

/** Enough of a header read to catch a truncated or hand-edited file. */
const derDefect = (entry: CorpusCertificate): string | null => {
  const [tag, first] = entry.der;
  if (tag !== 0x30) return `${entry.file}: not a SEQUENCE`;
  if (first === undefined) return `${entry.file}: truncated`;
  // 0x80 is BER's indefinite length, named so it is not reported as a length mismatch.
  if (first === 0x80) return `${entry.file}: BER indefinite length, forbidden in DER`;
  const lengthBytes = first < 0x80 ? 0 : first & 0x7f;
  const declared =
    lengthBytes === 0
      ? first
      : entry.der.slice(2, 2 + lengthBytes).reduce((total, byte) => total * 256 + byte, 0);
  const expected = 2 + lengthBytes + declared;
  return entry.der.length === expected
    ? null
    : `${entry.file}: declares ${expected} bytes, file is ${entry.der.length}`;
};

describe('the harvested certificate corpus', () => {
  it('is present', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(50);
  });

  it('stores each certificate once', () => {
    // Distinct fingerprints could be the same bytes if the dedup key regained a chain-position field.
    expect(distinct(corpus.map(entry => entry.sha256))).toBe(corpus.length);
  });

  it('has bytes matching the hash the manifest records', () => {
    const mismatched = corpus
      .filter(entry => createHash('sha256').update(entry.der).digest('hex') !== entry.sha256)
      .map(entry => entry.file);
    expect(mismatched).toEqual([]);
  });

  it('holds whole DER certificates', () => {
    expect(corpus.map(derDefect).filter(defect => defect !== null)).toEqual([]);
  });

  it('is deduplicated — no two certificates share a fingerprint', () => {
    const fingerprints = corpus.map(entry => JSON.stringify(entry.fingerprint));
    expect(distinct(fingerprints)).toBe(corpus.length);
  });

  it('spans the axes that make a certificate interesting', () => {
    // Floors just under what the live mail web yields, so a re-harvest that narrows the corpus fails.
    expect(distinct(corpus.map(e => e.fingerprint.signatureAlgorithm))).toBeGreaterThanOrEqual(6);
    expect(distinct(corpus.map(e => e.fingerprint.key))).toBeGreaterThanOrEqual(5);
    expect(distinct(corpus.map(e => e.fingerprint.extensions.join()))).toBeGreaterThanOrEqual(15);
    // RSA and EC both, never one family: they take different decode paths.
    const families = corpus.map(e => e.fingerprint.key.split('/')[0] ?? '');
    expect(distinct(families)).toBeGreaterThanOrEqual(2);
  });

  it('keeps the two encodings a naive decoder gets wrong', () => {
    // Named, not counted: one root uses GeneralizedTime and one an IA5String, and a diversity count would not miss them.
    const encodings = new Set(corpus.flatMap(entry => entry.fingerprint.asn1Types));
    expect([...encodings].sort()).toContain('GENERALIZEDTIME');
    expect([...encodings].sort()).toContain('IA5STRING');
  });

  it('covers every chain position, and more than one chain shape', () => {
    // `provenanceOf`, not every sighting: a sighting whose hash differs belongs to a deduplicated certificate.
    const provenance = corpus.flatMap(provenanceOf);
    for (const position of POSITIONS) expect(provenance.map(s => s.position)).toContain(position);
    expect(distinct(provenance.map(s => String(s.chainLength)))).toBeGreaterThanOrEqual(3);
  });

  it('can say where each stored certificate actually came from', () => {
    // Every entry needs a sighting that IS these bytes.
    const orphaned = corpus.filter(entry => provenanceOf(entry).length === 0).map(e => e.file);
    expect(orphaned).toEqual([]);
  });

  it('never claims a host served bytes it did not', () => {
    for (const entry of corpus) {
      for (const sighting of provenanceOf(entry)) expect(sighting.sha256).toBe(entry.sha256);
    }
  });

  it('records the hosts it could not reach', async () => {
    // An unreachable host is a missing CA, so it is recorded rather than dropped.
    const manifest = await loadManifest();
    expect(manifest.unreachable.filter(target => target.reason === '')).toEqual([]);
  });
});
