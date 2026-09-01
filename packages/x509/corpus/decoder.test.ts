/** The decoder against real bytes: the harvested corpus, the pinned limbo corpus, and mutants of both. */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { derFromPem } from '../harness/pem.ts';
import { LIMBO_CACHE } from '../harness/pin.ts';
import {
  DerError,
  type DerNode,
  decodeBitString,
  decodeBoolean,
  decodeDer,
  decodeInteger,
  decodeOid,
  decodeTime,
} from '../src/der.ts';
import { loadCorpus } from './load.ts';

const corpus = await loadCorpus();

const hexOf = (bytes: Uint8Array): string =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

describe('the harvested corpus', () => {
  it.each(corpus)('decodes $file', ({ der }) => {
    const certificate = decodeDer(der);
    // RFC 5280: Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    if (!certificate.isConstructed) throw new Error('a Certificate is a SEQUENCE');
    expect(certificate.tagNumber).toBe(16);
    expect(certificate.children).toHaveLength(3);
  });

  it.each(corpus)('retains $file tbsCertificate verbatim, as a view', ({ der }) => {
    const certificate = decodeDer(der);
    if (!certificate.isConstructed) throw new Error('a Certificate is a SEQUENCE');
    const [tbsCertificate] = certificate.children;
    if (tbsCertificate === undefined) throw new Error('a Certificate has a tbsCertificate');
    expect(tbsCertificate.bytes.buffer).toBe(der.buffer);
    expect(hexOf(tbsCertificate.bytes)).toBe(
      hexOf(
        der.subarray(tbsCertificate.offset, tbsCertificate.offset + tbsCertificate.bytes.length),
      ),
    );
  });
});

/** Gitignored and 39 MB; `pnpm -F @yozz.app/x509 limbo:fetch` turns it on. */
describe.skipIf(!existsSync(LIMBO_CACHE))('every certificate x509-limbo ships', () => {
  it('decodes, or names every certificate that did not', async () => {
    const { testcases } = z
      .object({
        testcases: z.array(
          z.object({
            trusted_certs: z.array(z.string()),
            untrusted_intermediates: z.array(z.string()),
            peer_certificate: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(LIMBO_CACHE, 'utf8')));

    const pems = new Set(
      testcases.flatMap(({ trusted_certs, untrusted_intermediates, peer_certificate }) => [
        ...trusted_certs,
        ...untrusted_intermediates,
        peer_certificate,
      ]),
    );
    const certificates = [...pems].flatMap(derFromPem);
    // A floor, not the exact count, so a bumped pin does not fail it.
    expect(certificates.length).toBeGreaterThan(9_000);

    const failures = certificates.flatMap(der => {
      try {
        decodeDer(der);
        return [];
      } catch (error) {
        return [`${hexOf(der.subarray(0, 16))}...: ${String(error)}`];
      }
    });
    expect(failures).toEqual([]);
  }, 120_000);
});

/** Mutation fuzzing seeded from the corpus, not coverage-guided: random mutation already saturates a parser this small. */
describe('fuzzing', () => {
  const ITERATIONS = 5_000;
  const TIME_BUDGET_MS = 20_000;
  const HEAP_BUDGET_BYTES = 256 * 1024 * 1024;

  /** xorshift32. Deterministic, so a failing mutant is reproducible from its seed. */
  const createRandom = (seed: number): (() => number) => {
    let state = seed;
    return () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
  };

  const mutate = (source: Uint8Array, random: () => number): Uint8Array => {
    const at = Math.floor(random() * source.length);
    const bytes = Uint8Array.from(source);
    switch (Math.floor(random() * 4)) {
      case 0:
        bytes[at] = (bytes[at] ?? 0) ^ (1 << Math.floor(random() * 8));
        return bytes;
      case 1:
        bytes[at] = Math.floor(random() * 256);
        return bytes;
      case 2:
        return bytes.subarray(0, at);
      default:
        return Uint8Array.from([
          ...bytes.subarray(0, at),
          Math.floor(random() * 256),
          ...bytes.subarray(at),
        ]);
    }
  };

  /** Every value decoder against every node: a wrong tag throws `DerError`, which is the outcome under test. */
  const exerciseValueDecoders = (node: DerNode): void => {
    for (const decode of [decodeBoolean, decodeInteger, decodeOid, decodeBitString, decodeTime]) {
      try {
        decode(node);
      } catch (error) {
        if (!(error instanceof DerError)) throw error;
      }
    }
    if (node.isConstructed) for (const child of node.children) exerciseValueDecoders(child);
  };

  it('throws DerError and nothing else, inside a time and heap budget', () => {
    const random = createRandom(0x5eed_1234);
    const startedAt = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const seed = corpus[iteration % corpus.length];
      if (seed === undefined) throw new Error('the corpus is empty');
      const mutant = mutate(seed.der, random);
      try {
        exerciseValueDecoders(decodeDer(mutant));
      } catch (error) {
        if (error instanceof DerError) continue;
        throw new Error(
          `iteration ${iteration} of ${seed.file} threw ${String(error)} on ${hexOf(mutant)}`,
        );
      }
    }

    expect(performance.now() - startedAt).toBeLessThan(TIME_BUDGET_MS);
    // Crude; the real defence is that nothing is allocated on a declared length.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(HEAP_BUDGET_BYTES);
  }, 60_000);
});
