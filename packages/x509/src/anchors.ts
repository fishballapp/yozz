/**
 * The trust store as a lookup rather than a scan.
 *
 * The spike measured 314ms of a 1376ms cold load going into parsing a root
 * bundle, and it was the only part of that number we control. The fix is not a
 * faster parser: it is not parsing 150 roots to find the one that matters.
 *
 * So the INDEX is built at compile time and the certificates are decoded lazily
 * — a lookup by issuer name touches one or two of them, and a chain that never
 * asks about a root never pays for it.
 *
 * The contract's `findCandidates` may over-approximate, and this deliberately
 * does: it keys on issuer name alone and ignores the authority key identifier,
 * because one name legitimately carries several keys — that is what a cross-sign
 * is — and the validator verifies every candidate it is handed anyway. Narrowing
 * here could only lose a valid path.
 */
import { decodeCertificate } from './certificate.ts';
import { DerError } from './der.ts';
import type { TrustAnchor, TrustAnchorSource } from './validator.ts';

/**
 * A Map key for raw bytes. Latin-1 is a total, injective byte-to-code-unit
 * mapping, so distinct DER produces distinct keys — unlike UTF-8 decoding, which
 * folds every invalid sequence onto U+FFFD and would make two different issuer
 * names collide.
 */
const keyOf = (bytes: Uint8Array): string =>
  String.fromCharCode(...Array.from(bytes.subarray(0, 512)));

/** One row of the compiled bundle: the certificate, plus the name to find it by. */
export type AnchorIndexEntry = {
  readonly id: string;
  readonly der: Uint8Array;
  readonly subjectDer: Uint8Array;
  /**
   * Mozilla's server distrust-after cutoff, read from `certdata.txt` at build
   * time because `cacert.pem` cannot carry it. `null` for nearly every root.
   */
  readonly serverDistrustAfter: Date | null;
};

/**
 * BUILD time. Decodes every certificate once to pull out its subject, and drops
 * any that does not decode here rather than at lookup time — a corrupt entry
 * must not become a runtime failure on a connection that had nothing to do
 * with it.
 */
export const indexAnchors = (
  bundle: readonly {
    readonly id: string;
    readonly der: Uint8Array;
    readonly serverDistrustAfter?: Date | null;
  }[],
): readonly AnchorIndexEntry[] =>
  bundle.flatMap(entry => {
    try {
      return [
        {
          ...entry,
          serverDistrustAfter: entry.serverDistrustAfter ?? null,
          subjectDer: decodeCertificate(entry.der).subject.der,
        },
      ];
    } catch (error) {
      if (error instanceof DerError) return [];
      throw error;
    }
  });

export type CompiledAnchors = {
  readonly source: TrustAnchorSource;
  /** How many certificates the bundle holds. */
  readonly size: number;
};

/**
 * RUNTIME. Builds the lookup and decodes NOTHING — that is the whole point. A
 * bundle of 150 roots costs one Map fill, and only the one or two certificates a
 * chain actually asks about are ever parsed.
 */
export const compileAnchors = (index: readonly AnchorIndexEntry[]): CompiledAnchors => {
  const bySubject = new Map<string, AnchorIndexEntry[]>();
  for (const entry of index) {
    const key = keyOf(entry.subjectDer);
    bySubject.set(key, [...(bySubject.get(key) ?? []), entry]);
  }

  return {
    size: index.length,
    source: {
      findCandidates: ({ issuerNameDer }): readonly TrustAnchor[] =>
        (bySubject.get(keyOf(issuerNameDer)) ?? [])
          // The key is a prefix for long names, so confirm the whole name.
          .filter(
            entry =>
              entry.subjectDer.length === issuerNameDer.length &&
              entry.subjectDer.every((byte, index) => byte === issuerNameDer[index]),
          )
          // Deliberately NOT decoded here. An earlier version parsed the
          // candidate and cached the result, which nothing read — the validator
          // re-decodes from `certificateDer` regardless, so the parse was pure
          // waste dressed up as a cache. The real win is not touching the other
          // 119 roots, and that needs no decoding at all.
          .map(entry => ({
            id: entry.id,
            certificateDer: entry.der,
            serverDistrustAfter: entry.serverDistrustAfter,
          })),
    },
  };
};
