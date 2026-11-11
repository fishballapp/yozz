/**
 * A box: a message anyone can seal to a public key and only that key's holder can open.
 *
 * ```
 * eph     = fresh X25519 pair, one per box, its private half dropped
 * shared  = X25519(ephPriv, recipientPub) = X25519(recipientPriv, ephPub)
 * key     = HKDF(shared, salt = ephPub ‖ recipientPub, info)
 * box     = ephPub ‖ iv ‖ AES-GCM(key, plaintext, aad)
 * ```
 *
 * The derivation is the CLI key's (`cli-key.ts`). Sealing needs no secret, so **a box says nothing
 * about who sealed it**: `aad` binds it to where it is stored, not to a sender.
 *
 * A **vouched box** is the other kind: only the two holders of a key pair each can make or open
 * one, so opening it with a sender's public key proves that sender (or the recipient itself) made
 * it. It hides nothing from either of them and carries what one vouches for to the other.
 *
 * ```
 * shared   = X25519(senderPriv, recipientPub) = X25519(recipientPriv, senderPub)
 * key      = HKDF(shared, salt = senderPub ‖ recipientPub, "vouched:" ‖ info)   → the order fixes the direction
 * vouched  = iv ‖ AES-GCM(key, plaintext, aad)
 * ```
 */

import { concat, nonShared, VaultError } from './bytes.ts';
import { hkdf } from './keys.ts';
import { freshIv, unsealBytes } from './sealed.ts';
import { agree, generateEphemeralKeyPair, type PrivateKey } from './x25519.ts';

const PUBLIC_KEY_BYTES = 32;

const boxKey = (
  shared: Uint8Array,
  info: string,
  { ephemeral, recipient }: { readonly ephemeral: Uint8Array; readonly recipient: Uint8Array },
): Promise<CryptoKey> =>
  hkdf(
    shared,
    info,
    { name: 'AES-GCM', length: 256 },
    ['encrypt', 'decrypt'],
    concat(ephemeral, recipient),
  );

export const sealBox = async ({
  recipient,
  info,
  aad,
  plaintext,
}: {
  /** The recipient's raw public key. */
  readonly recipient: Uint8Array<ArrayBuffer>;
  /** What this kind of box is for. Two kinds never share one, so a box of one never opens as the other. */
  readonly info: string;
  readonly aad: Uint8Array<ArrayBuffer>;
  readonly plaintext: Uint8Array<ArrayBuffer>;
}): Promise<Uint8Array<ArrayBuffer>> => {
  const ephemeral = await generateEphemeralKeyPair();
  const key = await boxKey(await agree(ephemeral.privateKey, recipient), info, {
    ephemeral: ephemeral.publicKey,
    recipient,
  });
  const iv = freshIv();
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    plaintext,
  );
  return concat(ephemeral.publicKey, iv, new Uint8Array(body));
};

export const openBox = async ({
  privateKey,
  info,
  aad,
  box,
  what,
}: {
  readonly privateKey: PrivateKey;
  readonly info: string;
  readonly aad: Uint8Array<ArrayBuffer>;
  readonly box: Uint8Array;
  /** Names the box in an error. */
  readonly what: string;
}): Promise<Uint8Array<ArrayBuffer>> => {
  if (box.length <= PUBLIC_KEY_BYTES) {
    throw new VaultError('malformed', `${what} is ${box.length} bytes, too short to be a box`);
  }
  const ephemeral = nonShared(box.subarray(0, PUBLIC_KEY_BYTES));
  const { iv, body } = unsealBytes(box.subarray(PUBLIC_KEY_BYTES), what);
  const key = await boxKey(await agree(privateKey.key, ephemeral), info, {
    ephemeral,
    recipient: privateKey.publicKey,
  });
  const opened = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, body)
    .catch(() => {
      throw new VaultError('unreadable', `${what} did not authenticate`);
    });
  return new Uint8Array(opened);
};

const vouchKey = (
  shared: Uint8Array,
  info: string,
  { sender, recipient }: { readonly sender: Uint8Array; readonly recipient: Uint8Array },
): Promise<CryptoKey> =>
  hkdf(
    shared,
    // Its own prefix, so a caller that reused one label for both kinds of box still gets two keys.
    `vouched:${info}`,
    { name: 'AES-GCM', length: 256 },
    ['encrypt', 'decrypt'],
    concat(sender, recipient),
  );

export const sealVouched = async ({
  sender,
  recipient,
  info,
  aad,
  plaintext,
}: {
  readonly sender: PrivateKey;
  /** The recipient's raw public key. */
  readonly recipient: Uint8Array<ArrayBuffer>;
  readonly info: string;
  readonly aad: Uint8Array<ArrayBuffer>;
  readonly plaintext: Uint8Array<ArrayBuffer>;
}): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await vouchKey(await agree(sender.key, recipient), info, {
    sender: sender.publicKey,
    recipient,
  });
  const iv = freshIv();
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    plaintext,
  );
  return concat(iv, new Uint8Array(body));
};

/** Throws `unreadable` unless `sender` (or the recipient itself) sealed exactly this, for this recipient. */
export const openVouched = async ({
  recipient,
  sender,
  info,
  aad,
  box,
  what,
}: {
  readonly recipient: PrivateKey;
  /** The raw public key of who is claimed to have vouched. */
  readonly sender: Uint8Array<ArrayBuffer>;
  readonly info: string;
  readonly aad: Uint8Array<ArrayBuffer>;
  readonly box: Uint8Array;
  readonly what: string;
}): Promise<Uint8Array<ArrayBuffer>> => {
  const { iv, body } = unsealBytes(box, what);
  const key = await vouchKey(await agree(recipient.key, sender), info, {
    sender,
    recipient: recipient.publicKey,
  });
  const opened = await crypto.subtle
    .decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, body)
    .catch(() => {
      throw new VaultError('unreadable', `${what} was not vouched for by this sender`);
    });
  return new Uint8Array(opened);
};
