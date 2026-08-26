/**
 * The decoder against REAL bytes — the half of the M2 gate that `src/der.test.ts`
 * cannot cover.
 *
 * The reject-list is authored, so it proves strictness and nothing about
 * compatibility. These three do the opposite:
 *
 *  - the 59 harvested certificates decode, field shapes intact;
 *  - every certificate in the pinned x509-limbo corpus decodes, which is the
 *    canary on the fail-closed universal-tag table — a table that over-rejects
 *    shows up here as thousands of failures rather than as one dead mail server
 *    at M8;
 *  - mutants of real certificates throw `DerError` or nothing else, ever.
 */
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

  /**
   * The property M3's signature verification rests on. Not "we can rebuild the
   * bytes" — the bytes are never rebuilt, they are the input's own memory.
   */
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

/**
 * Gitignored and 39MB, so absent on a fresh checkout and in CI. Skipped rather
 * than failed: `pnpm -F @yozz.app/x509 limbo:fetch` is what turns it on.
 */
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
    // A floor, not the exact count: the pin can move, and a canary that fails on
    // a bumped pin teaches nothing. It only has to prove the set is the whole
    // corpus rather than a handful.
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

/**
 * Mutation fuzzing, seeded from the corpus. NOT coverage-guided — V8 exposes
 * block coverage through the inspector, but a parser this small has a state
 * space random mutation of real certificates already saturates, and the
 * feedback loop would be more machinery than the thing it tests.
 *
 * ponytail: mutations are untargeted, so length octets are hit by chance rather
 * than by construction. If a length bug ever escapes to M8, weight the operator
 * table toward header offsets before reaching for coverage feedback.
 */
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

  /**
   * Every decoder against every node. A wrong tag throws `DerError`, which is
   * the outcome under test — so this fuzzes the value decoders for free, on
   * bytes that already survived the TLV layer.
   */
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
    // Crude, and the real defence is structural: nothing is ever allocated on a
    // declared length, so the only allocations are nodes bounded by input size.
    // This only has to catch a runaway.
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(HEAP_BUDGET_BYTES);
  }, 60_000);
});
