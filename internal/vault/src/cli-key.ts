/**
 * A CLI key: a third way into the vault, made from a vault that is already open.
 *
 * ```
 * CLI       static X25519 pair (cliPriv, cliPub)          → cliPriv never leaves the machine
 * browser   ephemeral X25519 pair (ephPriv, ephPub)       → one per approval, then dropped
 * shared    = X25519(ephPriv, cliPub) = X25519(cliPriv, ephPub)
 * encKey    = HKDF(shared, salt = ephPub ‖ cliPub, info "yozz-vault-cli-key")  → a VaultKey
 * tokenKey  = HKDF(shared, salt = ephPub ‖ cliPub, info "yozz-cli-token")      → seals the login, aad = state
 * code      = the first 40 bits of SHA-256(cliPub), Crockford base32, XXXX-XXXX
 * ```
 */

import { type CliLoginPayload, CliLoginPayloadSchema } from '@yozz.app/vault-contract';
import { concat, fromBase64, fromUtf8, toBase64Url, utf8, VaultError } from './bytes.ts';
import { hkdf, type VaultKey } from './keys.ts';
import { freshIv, sealed, unseal } from './sealed.ts';

const X25519 = { name: 'X25519' } as const;

const PUBLIC_KEY_BYTES = 32;

export type CliKeyPair = {
  /** Raw, base64url without padding: what the approve link and the Worker carry. */
  readonly publicKey: string;
  /** PKCS #8, base64url without padding: what the CLI's credentials keep. */
  readonly privateKey: string;
};

/** What both sides derive: the `VaultKey` the DEK is wrapped to, and the key the login (the bearer and its account) travels under. */
export type CliKeys = VaultKey & {
  readonly tokenKey: CryptoKey;
};

const decodePublicKey = (text: string, what: string): Uint8Array<ArrayBuffer> => {
  const bytes = fromBase64(text, what, 'base64url');
  if (bytes.length !== PUBLIC_KEY_BYTES) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes, want ${PUBLIC_KEY_BYTES}`);
  }
  return bytes;
};

const exportPublicKey = async (key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.exportKey('raw', key));

/** The salt binds both public keys in a fixed order, so neither side can be swapped for another under the same shared secret. */
const deriveKeys = async (
  privateKey: CryptoKey,
  peerPublicKey: Uint8Array<ArrayBuffer>,
  { ephemeral, cli }: { readonly ephemeral: Uint8Array; readonly cli: Uint8Array },
): Promise<CliKeys> => {
  const peer = await crypto.subtle.importKey('raw', peerPublicKey, X25519, false, []);
  const shared = await crypto.subtle
    .deriveBits({ name: 'X25519', public: peer }, privateKey, 256)
    .catch(() => {
      // WebCrypto refuses an all-zero secret, which is what a low-order public key forces.
      throw new VaultError('malformed', 'the public key is not one X25519 can agree with');
    });
  const material = new Uint8Array(shared);
  const salt = concat(ephemeral, cli);
  const [encKey, tokenKey] = await Promise.all([
    hkdf(
      material,
      'yozz-vault-cli-key',
      { name: 'AES-GCM', length: 256 },
      ['wrapKey', 'unwrapKey'],
      salt,
    ),
    hkdf(
      material,
      'yozz-cli-token',
      { name: 'AES-GCM', length: 256 },
      ['encrypt', 'decrypt'],
      salt,
    ),
  ]);
  return { encKey, tokenKey };
};

/** `yozz login`'s pair. The private half is extractable because the CLI writes it to its credentials. */
export const generateCliKeyPair = async (): Promise<CliKeyPair> => {
  const pair = await crypto.subtle.generateKey(X25519, true, ['deriveBits']);
  return {
    publicKey: toBase64Url(await exportPublicKey(pair.publicKey)),
    privateKey: toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)),
    ),
  };
};

/** The approving browser's side. The ephemeral private key never leaves this call. */
export const deriveApprovalKeys = async (
  cliPublicKey: string,
): Promise<CliKeys & { readonly ephemeralPublicKey: string }> => {
  const cli = decodePublicKey(cliPublicKey, 'the CLI public key');
  const pair = await crypto.subtle.generateKey(X25519, false, ['deriveBits']);
  const ephemeral = await exportPublicKey(pair.publicKey);
  return {
    ephemeralPublicKey: toBase64Url(ephemeral),
    ...(await deriveKeys(pair.privateKey, cli, { ephemeral, cli })),
  };
};

/** The CLI's side, at login and on every run. Its public key is read back from the private one rather than trusted beside it. */
export const deriveCliKeys = async ({
  privateKey,
  ephemeralPublicKey,
}: {
  readonly privateKey: string;
  readonly ephemeralPublicKey: string;
}): Promise<CliKeys> => {
  const ephemeral = decodePublicKey(ephemeralPublicKey, 'the ephemeral public key');
  const key = await crypto.subtle
    .importKey('pkcs8', fromBase64(privateKey, 'the CLI private key', 'base64url'), X25519, true, [
      'deriveBits',
    ])
    .catch(() => {
      throw new VaultError('malformed', 'the CLI private key is not an X25519 PKCS #8 key');
    });
  const { x } = await crypto.subtle.exportKey('jwk', key);
  if (x === undefined) throw new VaultError('malformed', 'the CLI private key has no public half');
  const cli = decodePublicKey(x, 'the CLI public key');
  return deriveKeys(key, ephemeral, { ephemeral, cli });
};

/**
 * The approval's answer to the CLI, sealed under `tokenKey` with the login's `state` as additional
 * data: it opens for that one login only, not for a callback replayed into another.
 */
export const sealCliLogin = async (
  tokenKey: CryptoKey,
  { state, payload }: { readonly state: string; readonly payload: CliLoginPayload },
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

export const openCliLogin = async (
  tokenKey: CryptoKey,
  { state, sealedLogin }: { readonly state: string; readonly sealedLogin: string },
): Promise<CliLoginPayload> => {
  const { iv, body } = unseal(sealedLogin, 'the sealed login');
  const opened = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv, additionalData: utf8(state) }, tokenKey, body)
    .catch(() => {
      throw new VaultError('unreadable', 'the sealed login did not authenticate');
    });
  const payload = (() => {
    try {
      return CliLoginPayloadSchema.safeParse(JSON.parse(fromUtf8(new Uint8Array(opened))));
    } catch {
      return null;
    }
  })();
  if (!payload?.success) {
    throw new VaultError('unreadable', 'the sealed login authenticated but is not a login');
  }
  return payload.data;
};

/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped has one spelling. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** What the terminal and the approve page both show, so the person can tell their own key from a link someone else made. */
export const pairingCode = async (cliPublicKey: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', decodePublicKey(cliPublicKey, 'the CLI public key')),
  );
  const bits = digest.subarray(0, 5).reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
  const symbols = Array.from({ length: 8 }, (_, index) =>
    CROCKFORD.charAt(Number((bits >> BigInt(35 - 5 * index)) & 31n)),
  ).join('');
  return `${symbols.slice(0, 4)}-${symbols.slice(4)}`;
};
