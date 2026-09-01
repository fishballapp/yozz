/**
 * The key schedule — one password in, everything the vault needs out.
 * ARCHITECTURE.md#keys is the spec; this file is it in code.
 *
 * ```
 * masterKey  = PBKDF2-HMAC-SHA256(password, salt = email, 650_000)
 * authValue  = PBKDF2-HMAC-SHA256(masterKey, salt = password, 1)   → to the server
 * encKey     = HKDF(masterKey, info "yozz-vault")                  → never leaves
 * ```
 *
 * Everything a password change is meant to rotate is here, and nothing else is
 * — the blind index's key hangs off the DEK instead, in `vault.ts`, because a
 * record id has to survive the password that filed it.
 *
 * **`authValue` cannot yield `encKey`.** It is a one-way function of
 * `masterKey` under a *different* salt, so a server holding it — Better Auth
 * hashes it again on arrival — does not hold anything that recovers
 * `masterKey`.
 *
 * **The password is the only entropy in this schedule**, so the 650,000
 * iterations and the password floor `apps/web` enforces are what stand between
 * a leaked `wrappedDek` and the vault. 650,000 is above OWASP's 600,000 floor
 * for PBKDF2-HMAC-SHA256; a memory-hard KDF would be stronger and needs a wasm
 * dependency WebCrypto cannot supply, which DECISIONS.md names as the upgrade
 * path rather than something taken now. Every primitive here is `SubtleCrypto`,
 * so no third-party crypto sits in the path protecting mailbox credentials.
 *
 * `encKey` is non-extractable and stays a `CryptoKey`. It has no form this
 * package can serialise, which is the point: the only thing that leaves is
 * `authValue`, and it leaves on purpose.
 */

import { nonShared, toBase64, utf8, VaultError } from './bytes.ts';

/** OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000; 1Password ships 650,000. */
const PBKDF2_ITERATIONS = 650_000;

/**
 * RFC 5869 §3.1: a zero-length salt is the defined default, and Extract then
 * keys its HMAC with HashLen zero bytes. It is the right shape here — a salt
 * earns its keep against low-entropy input material, and the input is a
 * 650,000-iteration derivation already salted by the email.
 */
const NO_SALT = new Uint8Array(0);

/**
 * The email is PBKDF2's salt, so it has to fold to the same bytes on every
 * device the user signs in from or the vault does not open — and the symptom
 * would be "wrong password" on a correct password, which sends a reader
 * nowhere near the cause.
 *
 * ASCII-only, deliberately. `String.prototype.toLowerCase` is full Unicode, and
 * Unicode's case-mapping tables are versioned: a browser that ships a new table
 * next year could fold an address differently from the browser that created the
 * vault and strand it. An ASCII fold is the same in every runtime forever.
 */
export const foldEmail = (email: string): string =>
  email.trim().replace(/[A-Z]/g, character => character.toLowerCase());

/**
 * The one key the vault itself needs. It wraps and unwraps the DEK, and nothing
 * else. Password mode derives it from the password (`deriveAccountKeys`);
 * passkey mode derives it from the authenticator's PRF output
 * (`derivePasskeyEncKey`). `createVault`, `openVault` and `rewrapDek` take only
 * this, so neither mode has to fake the other's fields.
 */
export type VaultKey = {
  readonly encKey: CryptoKey;
};

export type AccountKeys = VaultKey & {
  /** Sent to the server as the Better Auth password, and nothing else. */
  readonly authValue: string;
};

/**
 * One HKDF — Extract and Expand together, which is what WebCrypto's `HKDF`
 * fuses and the one place a TLS key schedule cannot use it. Nothing here needs
 * the halves apart. This is also the only place the salt convention lives:
 * `vault.ts` calls it too, over the DEK, so if the salt or the hash ever moves
 * it moves for every key at once rather than for the ones someone remembered.
 *
 * `length` is stated by every caller, because WebCrypto's default for an HMAC
 * key is the hash's BLOCK size — 512 bits for SHA-256, not 256. Both are
 * secure; a derived length nobody chose is a value no reader of the spec can
 * reproduce, and the OpenSSL control beside this file is what caught it.
 */
export const hkdf = async (
  inputKeyMaterial: Uint8Array,
  info: string,
  derived: AesKeyGenParams | HmacKeyGenParams,
  usages: readonly KeyUsage[],
): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: NO_SALT, info: utf8(info) },
    await crypto.subtle.importKey('raw', nonShared(inputKeyMaterial), 'HKDF', false, ['deriveKey']),
    derived,
    false,
    [...usages],
  );

const pbkdf2 = async (
  material: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey('raw', nonShared(material), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: nonShared(salt), iterations },
      key,
      256,
    ),
  );
};

/**
 * Two PBKDF2 passes, and the first is 650,000 iterations: **85ms measured in
 * Node** on an M-series laptop. That number does NOT carry to a browser — the
 * API and its parameters are identical, the implementations are not. Node is
 * OpenSSL; Chromium is BoringSSL, Gecko is NSS, WebKit is CommonCrypto on Apple
 * platforms, and `@yozz.app/tls` already measured those three disagreeing about
 * other WebCrypto details. Show something while it runs, and take the real
 * numbers in all three engines from the login screen — [unverified] still;
 * only Chromium has been measured. Once per unlock, never per record.
 */
export const deriveAccountKeys = async ({
  email,
  password,
}: {
  readonly email: string;
  readonly password: string;
}): Promise<AccountKeys> => {
  const passwordBytes = utf8(password);

  const masterKey = await pbkdf2(passwordBytes, utf8(foldEmail(email)), PBKDF2_ITERATIONS);

  return {
    authValue: toBase64(await pbkdf2(masterKey, passwordBytes, 1)),
    encKey: await hkdf(masterKey, 'yozz-vault', { name: 'AES-GCM', length: 256 }, [
      'wrapKey',
      'unwrapKey',
    ]),
  };
};

const PRF_OUTPUT_BYTES = 32;

/**
 * Passkey mode's `encKey`: HKDF over the 32 bytes the authenticator's PRF
 * extension returns for our label. No password is in the schedule — the PRF
 * output is already 256 random bits the authenticator will only release after
 * user verification, so this mode does not rest on what the user can remember.
 *
 * `hkdf` copies its input (`nonShared`), so a view into a larger WebAuthn
 * buffer is keyed by exactly its 32 bytes and not by the buffer around it.
 */
export const derivePasskeyEncKey = async (prfOutput: Uint8Array): Promise<CryptoKey> => {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new VaultError(
      'malformed',
      `the PRF output is ${prfOutput.length} bytes, want ${PRF_OUTPUT_BYTES}`,
    );
  }
  return hkdf(prfOutput, 'yozz-vault-passkey', { name: 'AES-GCM', length: 256 }, [
    'wrapKey',
    'unwrapKey',
  ]);
};
