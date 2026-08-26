/**
 * M3's gate: the harvested corpus decodes FIELD-FOR-FIELD against OpenSSL.
 *
 * `openssl x509 -text` is lossy — it normalises, and shows neither string type
 * nor tagging — so the comparison leans on the sub-commands that emit something
 * exact instead. `-pubkey` returns the SubjectPublicKeyInfo as bytes, which is a
 * byte-for-byte check on the field `tls` will hand to `importKey`; `-serial`,
 * `-startdate` and `-enddate` are unambiguous; and `-nameopt RFC2253,oid` prints
 * attribute types as dotted OIDs, so comparing names needs no name table that
 * could itself be wrong.
 *
 * Extension VALUES are compared through `-ext`, which is text and therefore the
 * weak half. The strong half is that these run over the same 59 certificates the
 * unit tests cannot reach: real string types, real time types, a v1 root, and
 * Entrust's private extension holding a GeneralString.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { derFromPem } from '../harness/pem.ts';
import { LIMBO_CACHE } from '../harness/pin.ts';
import { decodeCertificate, type Name } from '../src/certificate.ts';
import { decodeDer } from '../src/der.ts';
import { CERTS_DIR, loadCorpus } from './load.ts';

const corpus = await loadCorpus();

const hasOpenssl = ((): boolean => {
  try {
    return execFileSync('openssl', ['version'], { encoding: 'utf8' }).startsWith('OpenSSL');
  } catch {
    return false;
  }
})();

const openssl = (file: string, ...args: string[]): string =>
  execFileSync(
    'openssl',
    ['x509', '-in', join(CERTS_DIR, file), '-inform', 'DER', '-noout', ...args],
    {
      encoding: 'utf8',
    },
  );

/** RFC 2253 as OpenSSL writes it: RDNs most-specific first, `+` inside one RDN. */
const STRING_DECODERS: Readonly<Record<number, string>> = { 12: 'utf-8', 19: 'ascii', 22: 'ascii' };

const renderRfc2253 = (name: Name): string =>
  [...name.relativeDistinguishedNames]
    .reverse()
    .map(rdn =>
      rdn
        .map(({ oid, valueDer }) => {
          const value = decodeDer(valueDer);
          const encoding = STRING_DECODERS[value.tagNumber];
          if (encoding === undefined)
            throw new Error(`no decoder for string tag ${value.tagNumber}`);
          const text = new TextDecoder(encoding).decode(value.content);
          const escaped = text
            .replace(/([,+"\\<>;])/g, '\\$1')
            .replace(/^([#\s])/, '\\$1')
            .replace(/(\s)$/, '\\$1');
          return `${oid}=${escaped}`;
        })
        .join('+'),
    )
    .join(',');

const spkiFromPem = (pem: string): Uint8Array =>
  new Uint8Array(
    Buffer.from(pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, ''), 'base64'),
  );

describe.skipIf(!hasOpenssl)('field-for-field against OpenSSL', () => {
  it.each(corpus)('$file', ({ file, der }) => {
    const certificate = decodeCertificate(der);

    expect(`${certificate.version}`).toBe(
      openssl(file, '-text').match(/Version: (\d)/)?.[1] ?? 'no version printed',
    );

    // OpenSSL prints the serial as hex of the ENCODED integer, sign included.
    const serialHex = openssl(file, '-serial').trim().replace('serial=', '');
    expect(certificate.serialNumber).toBe(BigInt(`0x${serialHex}`));

    expect(certificate.notBefore.getTime()).toBe(
      new Date(openssl(file, '-startdate').trim().replace('notBefore=', '')).getTime(),
    );
    expect(certificate.notAfter.getTime()).toBe(
      new Date(openssl(file, '-enddate').trim().replace('notAfter=', '')).getTime(),
    );

    expect(renderRfc2253(certificate.issuer)).toBe(
      openssl(file, '-issuer', '-nameopt', 'RFC2253,oid,-esc_msb').trim().replace('issuer=', ''),
    );
    expect(renderRfc2253(certificate.subject)).toBe(
      openssl(file, '-subject', '-nameopt', 'RFC2253,oid,-esc_msb').trim().replace('subject=', ''),
    );

    // The strongest single assertion here: not "we can rebuild the SPKI" but
    // "the bytes we hand `tls` are the bytes OpenSSL reads out of the same file".
    expect([...certificate.subjectPublicKeyInfo.der]).toEqual([
      ...spkiFromPem(openssl(file, '-pubkey')),
    ]);
  });

  it.each(corpus)('$file extensions', ({ file, der }) => {
    const { extensions } = decodeCertificate(der);
    const text = openssl(file, '-text');

    const printed = (name: string): string | null => {
      const match = text.match(new RegExp(`X509v3 ${name}:( critical)? *\\n((?: {16}.*\\n)+)`));
      return match?.[2]?.trim() ?? null;
    };
    const isPrintedCritical = (name: string): boolean =>
      new RegExp(`X509v3 ${name}: critical`).test(text);

    const basicConstraints = printed('Basic Constraints');
    expect(extensions.basicConstraints?.value.isCa ?? null).toBe(
      basicConstraints === null ? null : basicConstraints.startsWith('CA:TRUE'),
    );
    const printedPathLength = basicConstraints?.match(/pathlen:(\d+)/)?.[1];
    expect(extensions.basicConstraints?.value.maximumPathLength ?? null).toBe(
      printedPathLength === undefined ? null : Number(printedPathLength),
    );
    if (extensions.basicConstraints !== null) {
      expect(extensions.basicConstraints.isCritical).toBe(isPrintedCritical('Basic Constraints'));
    }

    // OpenSSL prints SANs as `DNS:a, DNS:b, IP Address:1.2.3.4`.
    const printedDnsNames = (printed('Subject Alternative Name') ?? '')
      .split(/,\s*/)
      .flatMap(entry => (entry.startsWith('DNS:') ? [entry.slice(4)] : []));
    expect(
      (extensions.subjectAltName?.value ?? []).flatMap(name =>
        name.kind === 'dns' ? [name.value] : [],
      ),
    ).toEqual(printedDnsNames);

    expect(extensions.subjectKeyIdentifier !== null).toBe(
      printed('Subject Key Identifier') !== null,
    );
    expect(extensions.nameConstraints !== null).toBe(printed('Name Constraints') !== null);
  });
});

/**
 * Over-rejection is the failure mode a decoder cannot self-detect: every unit
 * test asserts that malformed input is refused, and none of them would notice if
 * valid input were refused too. This is the check that would.
 *
 * The rule is one-directional on purpose. A certificate we reject must belong to
 * a testcase x509-limbo expects to FAIL — decoding is allowed to be the reason a
 * case fails. Nothing here says a case expecting failure must fail at decode.
 */
describe.skipIf(!existsSync(LIMBO_CACHE))('over-rejection across x509-limbo', () => {
  it('refuses no certificate belonging to a testcase that expects SUCCESS', async () => {
    const { testcases } = z
      .object({
        testcases: z.array(
          z.object({
            id: z.string(),
            expected_result: z.enum(['SUCCESS', 'FAILURE']),
            trusted_certs: z.array(z.string()),
            untrusted_intermediates: z.array(z.string()),
            peer_certificate: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(await readFile(LIMBO_CACHE, 'utf8')));

    const overRejected = testcases.flatMap(testcase => {
      if (testcase.expected_result !== 'SUCCESS') return [];
      return [
        ...testcase.trusted_certs,
        ...testcase.untrusted_intermediates,
        testcase.peer_certificate,
      ]
        .flatMap(derFromPem)
        .flatMap(der => {
          try {
            decodeCertificate(der);
            return [];
          } catch (error) {
            return [`${testcase.id}: ${String(error)}`];
          }
        });
    });
    expect(overRejected).toEqual([]);
  }, 120_000);
});
