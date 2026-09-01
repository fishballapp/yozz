/**
 * ```
 * masterKey  = PBKDF2-HMAC-SHA256(password, salt = email, 650_000)
 * authValue  = PBKDF2-HMAC-SHA256(masterKey, salt = password, 1)   → to the server
 * encKey     = HKDF(masterKey, info "yozz-vault")                  → never leaves
 * ```
 */

import { nonShared, toBase64, utf8, VaultError } from './bytes.ts';

/** OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000; 1Password ships 650,000. */
const PBKDF2_ITERATIONS = 650_000;

/** RFC 5869 §3.1's default; the input material is already salted by the email. */
const NO_SALT = new Uint8Array(0);

/**
 * PBKDF2's salt, so it must fold identically on every device forever. ASCII-only because
 * `toLowerCase` follows Unicode's versioned case tables.
 */
export const foldEmail = (email: string): string =>
  email.trim().replace(/[A-Z]/g, character => character.toLowerCase());

/** Wraps and unwraps the DEK; from the password (`deriveAccountKeys`) or the passkey PRF (`derivePasskeyEncKey`). */
export type VaultKey = {
  readonly encKey: CryptoKey;
};

export type AccountKeys = VaultKey & {
  /** Sent to the server as the Better Auth password, and nothing else. */
  readonly authValue: string;
};

/** Callers state `length` because WebCrypto's default for an HMAC key is the hash's BLOCK size (512 for SHA-256). */
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
