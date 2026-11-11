/**
 * `<ns>` is the product's namespace: every label starts with it, so two products never derive the
 * same key from the same material.
 *
 * ```
 * masterKey  = PBKDF2-HMAC-SHA256(password, salt = email, 650_000)
 * authValue  = PBKDF2-HMAC-SHA256(masterKey, salt = password, 1)   → to the server
 * encKey     = HKDF(masterKey, info "<ns>-vault")                  → never leaves
 * passkey    → encKey = HKDF(prfOutput, info "<ns>-vault-passkey")
 * recovery   → encKey = HKDF(recoveryKey, info "<ns>-vault-recovery")
 * ```
 */

import { nonShared, toBase64, utf8, VaultError } from './bytes.ts';

/** OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000; 1Password ships 650,000. */
const PBKDF2_ITERATIONS = 650_000;

/** RFC 5869 §3.1's default: a password's material is already salted by the email, and a PRF output or a DEK is uniformly random. */
const NO_SALT = new Uint8Array(0);

/**
 * PBKDF2's salt, so it must fold identically on every device forever. ASCII-only because
 * `toLowerCase` follows Unicode's versioned case tables.
 */
export const foldEmail = (email: string): string =>
  email.trim().replace(/[A-Z]/g, character => character.toLowerCase());

/** Wraps and unwraps the DEK; from the password, the passkey PRF, a recovery key or a CLI key. */
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
  salt: Uint8Array<ArrayBuffer> = NO_SALT,
): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) },
    await crypto.subtle.importKey('raw', nonShared(inputKeyMaterial), 'HKDF', false, ['deriveKey']),
    derived,
    false,
    [...usages],
  );

/** HKDF's output as bytes, for a derived value that is not itself a WebCrypto key (a bearer, an X25519 private key). */
export const hkdfBytes = async (
  inputKeyMaterial: Uint8Array,
  info: string,
  salt: Uint8Array<ArrayBuffer> = NO_SALT,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: utf8(info) },
      await crypto.subtle.importKey('raw', nonShared(inputKeyMaterial), 'HKDF', false, [
        'deriveBits',
      ]),
      256,
    ),
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

const SECRET_BYTES = 32;

const wrappingKey = (
  material: Uint8Array,
  info: string,
  salt?: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> =>
  hkdf(material, info, { name: 'AES-GCM', length: 256 }, ['wrapKey', 'unwrapKey'], salt);

/** A uniformly random 32-byte secret (a PRF output, a recovery key) as the key the DEK is wrapped to. */
const wrappingKeyFromSecret = async (
  secret: Uint8Array,
  what: string,
  info: string,
): Promise<CryptoKey> => {
  if (secret.length !== SECRET_BYTES) {
    throw new VaultError('malformed', `${what} is ${secret.length} bytes, want ${SECRET_BYTES}`);
  }
  return wrappingKey(secret, info);
};

export const vaultKeys = (namespace: string) => ({
  deriveAccountKeys: async ({
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
      encKey: await wrappingKey(masterKey, `${namespace}-vault`),
    };
  },

  derivePasskeyEncKey: (prfOutput: Uint8Array): Promise<CryptoKey> =>
    wrappingKeyFromSecret(prfOutput, 'the PRF output', `${namespace}-vault-passkey`),

  /** For a vault whose loss cannot be repaired by starting again: a key its owner keeps offline. */
  deriveRecoveryEncKey: (recoveryKey: Uint8Array): Promise<CryptoKey> =>
    wrappingKeyFromSecret(recoveryKey, 'the recovery key', `${namespace}-vault-recovery`),
});
