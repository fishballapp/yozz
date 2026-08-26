/**
 * The fixture is hand-built rather than a slice of the real file, because the
 * property under test is structural: the cutoff hangs off two DIFFERENT object
 * classes, and a parser that reads one of them looks correct until the day the
 * root it missed is the one that matters.
 *
 * The real 1.3MB file is not committed. `anchors:fetch` pins it, and the last
 * test here runs against it when it is cached.
 */
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
    [...escaped.matchAll(/\\([0-7]{3})/g)].map(([, digits]) => Number.parseInt(digits, 8)),
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

/**
 * Izenpe's exact shape: the certificate lives on one object and the cutoff on
 * ANOTHER, joined only by issuer and serial. The certificate object itself says
 * `CK_FALSE`, which is what makes this the case a DER-keyed lookup gets wrong.
 */
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

  /**
   * The whole reason this module exists. Measured against NSS `70a8ff50`: three
   * cutoffs sit on `CKO_CERTIFICATE` and one on `CKO_NSS_TRUST`, and the one on
   * the trust object is `Izenpe.com` — the only root that is both still in
   * curl's bundle and already past its cutoff.
   */
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

  /**
   * RFC 5280 §4.1.2.5.1: "Where YY is greater than or equal to 50, the year
   * SHALL be interpreted as 19YY." Getting this backwards turns a 2049 cutoff
   * into 1949 and distrusts a root outright.
   */
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

  /**
   * Runs only when `anchors:fetch` has cached the pinned file, so `pnpm test`
   * stays offline. The numbers are the measurement the build step rests on, and
   * if they move, the pin moved and somebody should have read why.
   */
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

/**
 * The join the build step actually uses. `cacert.pem` hands it certificates, so
 * the cutoff has to arrive keyed by DER — and for Izenpe the DER and the cutoff
 * are on two different objects. Break this and a rebuild silently emits an
 * artifact with zero cutoffs, which no committed test would notice until the
 * next `anchors:build`.
 */
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
