/** Hand-built: the cutoff hangs off two different object classes. The real file runs only when `anchors:fetch` cached it. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  certificateDerKeys,
  derKey,
  issuerSerialKey,
  serverDistrustAfter,
  serverDistrustByCertificate,
} from './certdata.ts';
import { CERTDATA_CACHE } from './pin.ts';

/** `\ooo` per byte, the way the file writes them. */
const octalOf = (text: string): string =>
  [...text].map(char => `\\${char.charCodeAt(0).toString(8).padStart(3, '0')}`).join('');

const ISSUER = '\\060\\015\\061\\013';
const bytesOf = (escaped: string): Uint8Array =>
  Uint8Array.from(
    [...escaped.matchAll(/\\([0-7]{3})/g)].map(match => Number.parseInt(match[1] ?? '', 8)),
  );

const object = (
  cls: string,
  serial: string,
  cutoff: string | null,
  label: string,
  value?: string,
): string =>
  [
    `CKA_CLASS CK_OBJECT_CLASS ${cls}`,
    `CKA_LABEL UTF8 "${label}"`,
    ...(value === undefined ? [] : ['CKA_VALUE MULTILINE_OCTAL', value, 'END']),
    'CKA_ISSUER MULTILINE_OCTAL',
    ISSUER,
    'END',
    'CKA_SERIAL_NUMBER MULTILINE_OCTAL',
    serial,
    'END',
    cutoff === null
      ? 'CKA_NSS_SERVER_DISTRUST_AFTER CK_BBOOL CK_FALSE'
      : `CKA_NSS_SERVER_DISTRUST_AFTER MULTILINE_OCTAL\n${octalOf(cutoff)}\nEND`,
  ].join('\n');

/** Izenpe's shape: the certificate on one object, the cutoff on another, joined by issuer and serial. */
const SPLIT_DER = '\\060\\202\\001\\052';
const SPLIT_SERIAL = '\\002\\001\\004';
const SPLIT_PAIR = [
  object('CKO_CERTIFICATE', SPLIT_SERIAL, null, 'Split Root', SPLIT_DER),
  '',
  object('CKO_NSS_TRUST', SPLIT_SERIAL, '260415235959Z', 'Split Root'),
].join('\n');

const FIXTURE = [
  '# a comment, and a blank line, both of which appear mid-object in the real file',
  '',
  object('CKO_CERTIFICATE', '\\002\\001\\001', '241130235959Z', 'Retired Root'),
  '',
  object('CKO_NSS_TRUST', '\\002\\001\\002', '260415235959Z', 'Trust-Object Root'),
  '',
  object('CKO_CERTIFICATE', '\\002\\001\\003', null, 'Ordinary Root'),
  '',
].join('\n');

describe('the NSS distrust-after reader', () => {
  const cutoffs = serverDistrustAfter(FIXTURE);

  /** Against NSS `70a8ff50`: three cutoffs on `CKO_CERTIFICATE`, one (Izenpe.com) on `CKO_NSS_TRUST`. */
  it('reads a cutoff off either object class', () => {
    expect([...cutoffs.values()].map(entry => entry.label).toSorted()).toEqual([
      'Retired Root',
      'Trust-Object Root',
    ]);
  });

  it('ignores the CK_FALSE form, which is how the file says "no cutoff"', () => {
    expect(cutoffs.has(issuerSerialKey(bytesOf(ISSUER), bytesOf('\\002\\001\\003')))).toBe(false);
  });

  it('keys on issuer and serial, so a caller can look up by certificate', () => {
    const entry = cutoffs.get(issuerSerialKey(bytesOf(ISSUER), bytesOf('\\002\\001\\002')));
    expect(entry?.label).toBe('Trust-Object Root');
    expect(entry?.notAfter.toISOString()).toBe('2026-04-15T23:59:59.000Z');
  });

  /** RFC 5280 §4.1.2.5.1: YY >= 50 is 19YY. */
  it('splits the two-digit year at 50', () => {
    const past = serverDistrustAfter(
      object('CKO_CERTIFICATE', '\\002\\001\\011', '990101000000Z', 'Nineties'),
    );
    const future = serverDistrustAfter(
      object('CKO_CERTIFICATE', '\\002\\001\\012', '490101000000Z', 'Forties'),
    );
    expect([...past.values()][0]?.notAfter.getUTCFullYear()).toBe(1999);
    expect([...future.values()][0]?.notAfter.getUTCFullYear()).toBe(2049);
  });

  /** Runs only when `anchors:fetch` has cached the pinned file. */
  it.runIf(existsSync(CERTDATA_CACHE))('finds four cutoffs in the pinned NSS data', () => {
    const real = serverDistrustAfter(readFileSync(CERTDATA_CACHE, 'utf8'));
    expect(real.size).toBe(4);
    expect([...real.values()].map(entry => entry.label).toSorted()).toEqual([
      'Entrust Root Certification Authority - EC1',
      'Entrust Root Certification Authority - G2',
      'Entrust.net Premium 2048 Secure Server CA',
      'Izenpe.com',
    ]);
  });
});

/** The join the build uses: `cacert.pem` hands it certificates, so cutoffs must arrive keyed by DER. */
describe('cutoffs keyed by certificate, the way the build step reads them', () => {
  it("carries a trust object's cutoff onto its certificate's DER", () => {
    const byDer = serverDistrustByCertificate(SPLIT_PAIR);
    const entry = byDer.get(derKey(bytesOf(SPLIT_DER)));
    expect(entry?.label).toBe('Split Root');
    expect(entry?.notAfter.toISOString()).toBe('2026-04-15T23:59:59.000Z');
  });

  it('leaves a certificate whose trust object says CK_FALSE alone', () => {
    const byDer = serverDistrustByCertificate(
      object('CKO_CERTIFICATE', '\\002\\001\\005', null, 'Plain Root', SPLIT_DER),
    );
    expect(byDer.size).toBe(0);
  });

  /** What the build fails on: a bundle root certdata has never heard of. */
  it('lists every certificate certdata holds, so the build can spot one it does not', () => {
    expect(certificateDerKeys(SPLIT_PAIR).has(derKey(bytesOf(SPLIT_DER)))).toBe(true);
    expect(certificateDerKeys(SPLIT_PAIR).size).toBe(1);
  });
});
