/**
 * Guards the corpus itself, because everything M2 and M3 assert is only as good
 * as these bytes. A corpus that silently shrinks to three near-identical Let's
 * Encrypt leaves still passes a decoder gate — and proves nothing.
 *
 * No network and no openssl: this runs in `pnpm test`, the harvest does not.
 */
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

/**
 * Describes the defect, or null when the file is exactly one DER SEQUENCE.
 * Enough of a header read to catch a truncated or hand-edited file; the real
 * decoder is M2, and this only asserts the corpus is not already broken.
 */
const derDefect = (entry: CorpusCertificate): string | null => {
  const [tag, first] = entry.der;
  if (tag !== 0x30) return `${entry.file}: not a SEQUENCE`;
  if (first === undefined) return `${entry.file}: truncated`;
  // 0x80 is BER's indefinite length, which DER forbids outright. Named here
  // because otherwise it falls into the long-form branch as "0 length bytes"
  // and gets reported as a length mismatch — the wrong defect, in the one file
  // whose job is saying precisely what is wrong with a hand-edited certificate.
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
    // Distinct fingerprints can still be the same bytes if the dedup key ever
    // regains a chain-position field — the mistake this asserts against.
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
    // Floors, not targets, and set just under what the live mail web actually
    // yields. They fail when a re-harvest quietly narrows the corpus, which is
    // the only way this file can rot. Raising one means widening TARGETS first.
    expect(distinct(corpus.map(e => e.fingerprint.signatureAlgorithm))).toBeGreaterThanOrEqual(6);
    expect(distinct(corpus.map(e => e.fingerprint.key))).toBeGreaterThanOrEqual(5);
    expect(distinct(corpus.map(e => e.fingerprint.extensions.join()))).toBeGreaterThanOrEqual(15);
    // RSA and EC both, never one family: they take different decode paths.
    const families = corpus.map(e => e.fingerprint.key.split('/')[0] ?? '');
    expect(distinct(families)).toBeGreaterThanOrEqual(2);
  });

  it('keeps the two encodings a naive decoder gets wrong', () => {
    // Named rather than counted, because these are the whole reason the root
    // store is harvested: every mail host on the internet dates itself in
    // UTCTime and spells its DN in PrintableString or UTF8String. One root
    // uses GeneralizedTime and one an IA5String, and losing either to a
    // re-harvest would go unnoticed behind a diversity count.
    const encodings = new Set(corpus.flatMap(entry => entry.fingerprint.asn1Types));
    expect([...encodings].sort()).toContain('GENERALIZEDTIME');
    expect([...encodings].sort()).toContain('IA5STRING');
  });

  it('covers every chain position, and more than one chain shape', () => {
    // provenanceOf, NOT every sighting: a sighting whose hash differs belongs to
    // a certificate that was deduplicated away, and counting its position would
    // claim coverage from bytes this corpus does not hold.
    const provenance = corpus.flatMap(provenanceOf);
    for (const position of POSITIONS) expect(provenance.map(s => s.position)).toContain(position);
    expect(distinct(provenance.map(s => String(s.chainLength)))).toBeGreaterThanOrEqual(3);
  });

  it('can say where each stored certificate actually came from', () => {
    // Every entry must have at least one sighting that IS these bytes. An entry
    // built only from absorbed sightings would have no traceable origin at all.
    const orphaned = corpus.filter(entry => provenanceOf(entry).length === 0).map(e => e.file);
    expect(orphaned).toEqual([]);
  });

  it('never claims a host served bytes it did not', () => {
    // The defect this replaced: `sources` listed every target that shared a
    // fingerprint, so the manifest asserted rambler.ru served DigiCert Global
    // Root G2. It serves GlobalSign Root CA R3. A sighting is now only ever
    // read as provenance when its own hash matches.
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
