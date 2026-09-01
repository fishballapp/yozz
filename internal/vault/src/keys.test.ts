/**
 * The key schedule against OpenSSL.
 *
 * `node:crypto` is not a mirror of the code under test the way a second call to
 * `crypto.subtle` would be — it is OpenSSL, a separate implementation of the
 * same three RFCs, reached through a separate API. So re-deriving the whole
 * schedule with it and comparing checks every parameter that has no other way
 * of being wrong loudly: the iteration count, which value is the salt in each
 * PBKDF2 pass, the ASCII email fold, the empty HKDF salt, and all three `info`
 * strings. Getting any of them wrong still produces 32 plausible bytes.
 *
 * Every derived key is non-extractable, so none is compared directly. They are
 * compared through what they DO: OpenSSL unwraps the DEK that `encKey` sealed,
 * derives the DEK's two children itself, reproduces the record id `indexKey`
 * signed, and opens a real record under `recordKey`. Three `info` labels, and
 * the exact bytes of the AEAD's additional data, all pinned that way.
 */

import { createDecipheriv, createHmac, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveAccountKeys, derivePasskeyEncKey, foldEmail } from './keys.ts';
import { createVault, openVault } from './vault.ts';

const EMAIL = 'Jason@Example.com ';
const PASSWORD = 'correct horse battery staple';

/**
 * The ASCII fold, spelled out rather than reached for as `toLowerCase()` — the
 * control has to pin WHICH fold, or the day production switched to full Unicode
 * casing every test in this file would still pass.
 */
const asciiFold = (email: string): string =>
  [...email.trim()]
    .map(character =>
      character >= 'A' && character <= 'Z'
        ? String.fromCharCode(character.charCodeAt(0) + 0x20)
        : character,
    )
    .join('');

/** The same derivations as `keys.ts`, written independently over OpenSSL. */
const openssl = (
  email: string,
  password: string,
): { readonly masterKey: Buffer; readonly encKey: Buffer } => {
  const masterKey = pbkdf2Sync(password, asciiFold(email), 650_000, 32, 'sha256');
  return {
    masterKey,
    encKey: Buffer.from(
      hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from('yozz-vault'), 32),
    ),
  };
};

/** AES-256-GCM the way WebCrypto lays it out: `iv ‖ ciphertext ‖ tag`. */
const opensslOpen = (
  sealed: Buffer,
  key: Buffer,
  { additionalData }: { additionalData?: Buffer } = {},
): Buffer => {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  if (additionalData) decipher.setAAD(additionalData);
  return Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final(),
  ]);
};

describe('deriveAccountKeys', () => {
  it('derives the authValue OpenSSL derives', async () => {
    const { authValue } = await deriveAccountKeys({ email: EMAIL, password: PASSWORD });

    const { masterKey } = openssl(EMAIL, PASSWORD);
    expect(authValue).toBe(pbkdf2Sync(masterKey, PASSWORD, 1, 32, 'sha256').toString('base64'));
  });

  it('is not the masterKey it came from', async () => {
    const { authValue } = await deriveAccountKeys({ email: EMAIL, password: PASSWORD });
    const { masterKey } = openssl(EMAIL, PASSWORD);

    // Skipping the second PBKDF2 pass would send the server the very value
    // every other key is derived from, and it would look like a working login.
    expect(authValue).not.toBe(masterKey.toString('base64'));
  });

  it('derives an encKey that unwraps the DEK under OpenSSL, and an index key from it', async () => {
    const keys = await deriveAccountKeys({ email: EMAIL, password: PASSWORD });
    const { vault, wrappedDek } = await createVault(keys);

    // One chain, end to end, and every link is OpenSSL's: password → masterKey
    // → encKey → the DEK out of the wrapped bytes → indexKey → the record id
    // `vault.recordId` just produced. Nothing here is compared against a second
    // call to the code under test.
    const { encKey } = openssl(EMAIL, PASSWORD);
    const dek = opensslOpen(Buffer.from(wrappedDek, 'base64'), encKey);
    expect(dek).toHaveLength(32);

    const child = (info: string) =>
      Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from(info), 32));

    const id = createHmac('sha256', child('yozz-vault-index'))
      .update(JSON.stringify(['account', 'jason@posteo.de']))
      .digest('base64url');
    expect(await vault.recordId('account', 'jason@posteo.de')).toBe(id);

    // …and the last link: OpenSSL opens an actual record, which pins the record
    // key's own label and the exact bytes of the AEAD's additional data.
    const { ciphertext } = await vault.encryptRecord({
      type: 'account',
      naturalKey: 'jason@posteo.de',
      revision: 7,
      plaintext: '{"password":"hunter2"}',
    });
    expect(
      opensslOpen(Buffer.from(ciphertext, 'base64'), child('yozz-vault-record'), {
        additionalData: Buffer.from(JSON.stringify([id, 'account'])),
      }).toString(),
    ).toBe(JSON.stringify(['7', 'jason@posteo.de', '{"password":"hunter2"}']));
  });

  it('folds the email so a second device typing it differently still opens the vault', async () => {
    const typed = await deriveAccountKeys({ email: '  JASON@example.COM', password: PASSWORD });
    const canonical = await deriveAccountKeys({ email: 'jason@example.com', password: PASSWORD });

    expect(typed.authValue).toBe(canonical.authValue);
  });

  it('folds ASCII and nothing wider', async () => {
    // U+212A KELVIN SIGN lowercases to `k` under full Unicode casing and stays
    // itself under an ASCII fold. Two addresses differing only there must
    // therefore derive two different vaults — and if `foldEmail` ever became
    // `toLowerCase()`, this is the test that would notice.
    const kelvin = await deriveAccountKeys({ email: 'jason@e\u212Aample.com', password: PASSWORD });
    const latin = await deriveAccountKeys({ email: 'jason@ekample.com', password: PASSWORD });

    expect(kelvin.authValue).not.toBe(latin.authValue);
  });

  it('gives a different authValue for a different address or password', async () => {
    const base = await deriveAccountKeys({ email: EMAIL, password: PASSWORD });

    for (const changed of [
      { email: 'someone@example.com', password: PASSWORD },
      { email: EMAIL, password: `${PASSWORD}!` },
    ]) {
      expect((await deriveAccountKeys(changed)).authValue).not.toBe(base.authValue);
    }
  });

  it('opens the same vault on a second device from the password alone', async () => {
    const [here, elsewhere] = await Promise.all([
      deriveAccountKeys({ email: EMAIL, password: PASSWORD }),
      deriveAccountKeys({ email: EMAIL, password: PASSWORD }),
    ]);

    // The whole point of the schedule holding nothing device-local: a browser
    // that has never seen this account derives both halves from what the user
    // typed. Same authValue, so the login succeeds, and an interchangeable
    // encKey, so the vault the first device wrapped opens on the second.
    expect(elsewhere.authValue).toBe(here.authValue);

    const { wrappedDek } = await createVault(here);
    await expect(openVault(elsewhere, wrappedDek)).resolves.toBeDefined();
  });
});

describe('derivePasskeyEncKey', () => {
  it('is a non-extractable AES-GCM-256 wrap key, the same for the same PRF bytes', async () => {
    const prf = new Uint8Array(32).fill(42);
    const [a, b] = await Promise.all([derivePasskeyEncKey(prf), derivePasskeyEncKey(prf)]);

    expect(a.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    expect(a.usages).toEqual(['wrapKey', 'unwrapKey']);
    expect(a.extractable).toBe(false);

    // Same key material, so a vault wrapped under one opens under the other.
    const { wrappedDek } = await createVault({ encKey: a });
    await expect(openVault({ encKey: b }, wrappedDek)).resolves.toBeDefined();
  });

  it('keys by the view, not the buffer it sits in', async () => {
    const prf = new Uint8Array(32).fill(42);
    const padded = new Uint8Array(64);
    padded.set(prf, 16);
    const view = padded.subarray(16, 48);

    const { wrappedDek } = await createVault({ encKey: await derivePasskeyEncKey(prf) });
    await expect(
      openVault({ encKey: await derivePasskeyEncKey(view) }, wrappedDek),
    ).resolves.toBeDefined();
  });

  it('refuses anything but 32 bytes', async () => {
    await expect(derivePasskeyEncKey(new Uint8Array(16))).rejects.toMatchObject({
      code: 'malformed',
    });
  });

  it('foldEmail trims and folds ASCII only', () => {
    expect(foldEmail('  Alice.Smith@Example.COM  ')).toBe('alice.smith@example.com');
    expect(foldEmail('İ@x.com')).toBe('İ@x.com');
  });
});
