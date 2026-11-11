/**
 * A CLI key: a third way into the vault, made from a vault that is already open. `<ns>` is the
 * product's namespace (`cliKeys`).
 *
 * ```
 * CLI       static X25519 pair (cliPriv, cliPub)          → cliPriv never leaves the machine
 * browser   ephemeral X25519 pair (ephPriv, ephPub)       → one per approval, then dropped
 * shared    = X25519(ephPriv, cliPub) = X25519(cliPriv, ephPub)
 * encKey    = HKDF(shared, salt = ephPub ‖ cliPub, info "<ns>-vault-cli-key")  → a VaultKey
 * tokenKey  = HKDF(shared, salt = ephPub ‖ cliPub, info "<ns>-cli-token")      → seals the login, aad = state
 * code      = the first 40 bits of SHA-256(cliPub), Crockford base32, XXXX-XXXX
 * ```
 */

import { concat, fromUtf8, toBase64Url, utf8, VaultError } from './bytes.ts';
import { hkdf, type VaultKey } from './keys.ts';
import { freshIv, sealed, unseal } from './sealed.ts';
import { agree, decodePublicKey, generateEphemeralKeyPair, importPrivateKey } from './x25519.ts';

/** What both sides derive: the `VaultKey` the DEK is wrapped to, and the key the login (the bearer and its account) travels under. */
export type CliKeys = VaultKey & {
  readonly tokenKey: CryptoKey;
};

export const cliKeys = (namespace: string) => {
  /** The salt binds both public keys in a fixed order, so neither side can be swapped for another under the same shared secret. */
  const deriveKeys = async (
    privateKey: CryptoKey,
    peerPublicKey: Uint8Array<ArrayBuffer>,
    { ephemeral, cli }: { readonly ephemeral: Uint8Array; readonly cli: Uint8Array },
  ): Promise<CliKeys> => {
    const material = await agree(privateKey, peerPublicKey);
    const salt = concat(ephemeral, cli);
    const [encKey, tokenKey] = await Promise.all([
      hkdf(
        material,
        `${namespace}-vault-cli-key`,
        { name: 'AES-GCM', length: 256 },
        ['wrapKey', 'unwrapKey'],
        salt,
      ),
      hkdf(
        material,
        `${namespace}-cli-token`,
        { name: 'AES-GCM', length: 256 },
        ['encrypt', 'decrypt'],
        salt,
      ),
    ]);
    return { encKey, tokenKey };
  };

  return {
    /** The approving browser's side. The ephemeral private key never leaves this call. */
    deriveApprovalKeys: async (
      cliPublicKey: string,
    ): Promise<CliKeys & { readonly ephemeralPublicKey: string }> => {
      const cli = decodePublicKey(cliPublicKey, 'the CLI public key');
      const ephemeral = await generateEphemeralKeyPair();
      return {
        ephemeralPublicKey: toBase64Url(ephemeral.publicKey),
        ...(await deriveKeys(ephemeral.privateKey, cli, { ephemeral: ephemeral.publicKey, cli })),
      };
    },

    /** The CLI's side, at login and on every run. */
    deriveCliKeys: async ({
      privateKey,
      ephemeralPublicKey,
    }: {
      readonly privateKey: string;
      readonly ephemeralPublicKey: string;
    }): Promise<CliKeys> => {
      const ephemeral = decodePublicKey(ephemeralPublicKey, 'the ephemeral public key');
      const cli = await importPrivateKey(privateKey, 'the CLI private key');
      return deriveKeys(cli.key, ephemeral, { ephemeral, cli: cli.publicKey });
    },
  };
};

/**
 * The approval's answer to the CLI, sealed under `tokenKey` with the login's `state` as additional
 * data: it opens for that one login only, not for a callback replayed into another.
 */
export const sealCliLogin = async (
  tokenKey: CryptoKey,
  { state, payload }: { readonly state: string; readonly payload: unknown },
): Promise<string> => {
  const iv = freshIv();
  return sealed(
    iv,
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: utf8(state) },
        tokenKey,
        utf8(JSON.stringify(payload)),
      ),
    ),
  );
};

/** The payload as JSON, authenticated and not yet validated: its shape is the caller's to check. */
export const openCliLogin = async (
  tokenKey: CryptoKey,
  { state, sealedLogin }: { readonly state: string; readonly sealedLogin: string },
): Promise<unknown> => {
  const { iv, body } = unseal(sealedLogin, 'the sealed login');
  const opened = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv, additionalData: utf8(state) }, tokenKey, body)
    .catch(() => {
      throw new VaultError('unreadable', 'the sealed login did not authenticate');
    });
  try {
    return JSON.parse(fromUtf8(new Uint8Array(opened)));
  } catch {
    throw new VaultError('unreadable', 'the sealed login authenticated but is not JSON');
  }
};
