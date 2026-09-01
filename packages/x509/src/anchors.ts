/**
 * The index is built at compile time and certificates decode lazily, so a lookup touches one or two
 * roots. Keyed on issuer name alone: one name carries several keys when cross-signed.
 */
import { decodeCertificate } from './certificate.ts';
import { DerError } from './der.ts';
import type { TrustAnchor, TrustAnchorSource } from './validator.ts';

/** Latin-1 is injective byte-to-code-unit; UTF-8 decoding would fold invalid sequences onto U+FFFD. */
const keyOf = (bytes: Uint8Array): string =>
  String.fromCharCode(...Array.from(bytes.subarray(0, 512)));

export type AnchorIndexEntry = {
  readonly id: string;
  readonly der: Uint8Array;
  readonly subjectDer: Uint8Array;
  /** From `certdata.txt` at build time; `cacert.pem` cannot carry it. */
  readonly serverDistrustAfter: Date | null;
};

/** Build time. A certificate that does not decode is dropped here rather than failing a lookup later. */
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
  readonly size: number;
};

/** Runtime. Decodes nothing. */
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
          // The key is a prefix for long names.
          .filter(
            entry =>
              entry.subjectDer.length === issuerNameDer.length &&
              entry.subjectDer.every((byte, index) => byte === issuerNameDer[index]),
          )
          .map(entry => ({
            id: entry.id,
            certificateDer: entry.der,
            serverDistrustAfter: entry.serverDistrustAfter,
          })),
    },
  };
};
