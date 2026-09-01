/**
 * ```
 * DEK        = random 256 bits
 * wrappedDEK = AES-GCM(encKey, DEK)                          → stored server-side
 * recordKey  = HKDF(DEK, info "yozz-vault-record")
 * indexKey   = HKDF(DEK, info "yozz-vault-index")
 * id         = HMAC(indexKey, [type, naturalKey])            → stored server-side
 * ciphertext = AES-GCM(recordKey, [revision, naturalKey, plaintext],
 *                      aad = [id, type])                     → stored server-side
 * ```
 */

import {
  concat,
  fromBase64,
  fromUtf8,
  nonShared,
  toBase64,
  toBase64Url,
  utf8,
  VaultError,
} from './bytes.ts';
import { hkdf, type VaultKey } from './keys.ts';

/** RFC 5116 §5.1. */
const IV_BYTES = 12;

export type EncryptedRecord = {
  readonly id: string;
  readonly type: string;
  /** base64 of `iv ‖ AES-GCM(recordKey, [revision, naturalKey, plaintext])`. */
  readonly ciphertext: string;
};

/** The revision is reported, never refused: refusing needs a per-record high-water mark, which `freshVault` owns. */
export type OpenedRecord = {
  readonly revision: number;
  readonly plaintext: string;
};

export type Vault = {
  readonly recordId: (type: string, naturalKey: string) => Promise<string>;
  /** `revision` is the caller's: one above the revision it read. */
  readonly encryptRecord: (item: {
    readonly type: string;
    readonly naturalKey: string;
    readonly revision: number;
    readonly plaintext: string;
  }) => Promise<EncryptedRecord>;
  /** Takes the pair the lookup used rather than an id, because an id from the store is an id the store chose. */
  readonly decryptRecord: (item: {
    readonly type: string;
    readonly naturalKey: string;
    readonly ciphertext: string;
  }) => Promise<OpenedRecord>;
  /** For a listing, where no natural key is known going in; it comes back authenticated. */
  readonly decryptListedRecord: (
    type: string,
    listed: { readonly id: string; readonly ciphertext: string },
  ) => Promise<OpenedRecord & { readonly naturalKey: string }>;
};

/** JSON rather than a separator: `${type}:${naturalKey}` is not injective. */
const tuple = (...parts: readonly string[]): Uint8Array<ArrayBuffer> => utf8(JSON.stringify(parts));

const untuple = (bytes: Uint8Array, what: string): readonly string[] => {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(fromUtf8(bytes));
    } catch {
      throw new VaultError('unreadable', `${what} authenticated but is not JSON`);
    }
  })();
  if (!Array.isArray(parsed) || parsed.some(part => typeof part !== 'string')) {
    throw new VaultError('unreadable', `${what} authenticated but is not a tuple of strings`);
  }
  return parsed;
};

/** The round-trip check rejects `""`, `" 1"`, `"01"` and `"1e3"`, which `Number()` alone accepts. */
const asRevision = (text: string, what: string): number => {
  const revision = Number(text);
  if (!Number.isSafeInteger(revision) || revision < 0 || String(revision) !== text) {
    throw new VaultError('unreadable', `${what} authenticated but carries no usable revision`);
  }
  return revision;
};

const sealed = (iv: Uint8Array, body: Uint8Array): string => toBase64(concat(iv, body));

const unseal = (
  text: string,
  what: string,
): { iv: Uint8Array<ArrayBuffer>; body: Uint8Array<ArrayBuffer> } => {
  const bytes = fromBase64(text, what);
  if (bytes.length <= IV_BYTES) {
    throw new VaultError('malformed', `${what} is ${bytes.length} bytes, too short to hold an IV`);
  }
  return { iv: nonShared(bytes.subarray(0, IV_BYTES)), body: nonShared(bytes.subarray(IV_BYTES)) };
};

/** Random, not a counter: several devices write under one DEK without seeing each other. NIST SP 800-38D bounds this at ~2^32 writes per DEK. */
const freshIv = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(IV_BYTES));

const wrap = async (encKey: CryptoKey, dek: CryptoKey): Promise<string> => {
  const iv = freshIv();
  return sealed(
    iv,
    new Uint8Array(await crypto.subtle.wrapKey('raw', dek, encKey, { name: 'AES-GCM', iv })),
  );
};

/** Extractable: `openVault` needs the raw bytes for HKDF and `wrapKey` refuses a non-extractable key. The handle never escapes. */
const unwrap = async (encKey: CryptoKey, wrappedDek: string): Promise<CryptoKey> => {
  const { iv, body } = unseal(wrappedDek, 'the wrapped DEK');
  return crypto.subtle
    .unwrapKey(
      'raw',
      body,
      encKey,
      { name: 'AES-GCM', iv },
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    .catch(() => {
      throw new VaultError('unreadable', 'the wrapped DEK did not authenticate');
    });
};

export const createVault = async (
  keys: VaultKey,
): Promise<{ readonly vault: Vault; readonly wrappedDek: string }> => {
  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
  const wrappedDek = await wrap(keys.encKey, generated);
  return { vault: await openVault(keys, wrappedDek), wrappedDek };
};

export const rewrapDek = async (
  from: VaultKey,
  to: VaultKey,
  wrappedDek: string,
): Promise<string> => wrap(to.encKey, await unwrap(from.encKey, wrappedDek));

/** An `unreadable` failure here means the wrong password, in password mode. */
export const openVault = async (keys: VaultKey, wrappedDek: string): Promise<Vault> => {
  // WebCrypto cannot re-key an AES-GCM `CryptoKey` into HKDF material, so the DEK passes through as bytes.
  const raw = new Uint8Array(
    await crypto.subtle.exportKey('raw', await unwrap(keys.encKey, wrappedDek)),
  );
  const [recordKey, indexKey] = await Promise.all([
    hkdf(raw, 'yozz-vault-record', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    hkdf(raw, 'yozz-vault-index', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);

  const recordId = async (type: string, naturalKey: string): Promise<string> =>
    toBase64Url(
      new Uint8Array(await crypto.subtle.sign('HMAC', indexKey, tuple(type, naturalKey))),
    );

  const open = async (
    id: string,
    type: string,
    ciphertext: string,
  ): Promise<OpenedRecord & { readonly naturalKey: string }> => {
    const { iv, body } = unseal(ciphertext, `record ${id}`);
    const opened = await crypto.subtle
      .decrypt({ name: 'AES-GCM', iv, additionalData: tuple(id, type) }, recordKey, body)
      .catch(() => {
        throw new VaultError('unreadable', `record ${id} did not authenticate`);
      });

    const [revision, naturalKey, plaintext] = untuple(new Uint8Array(opened), `record ${id}`);
    if (revision === undefined || naturalKey === undefined || plaintext === undefined) {
      throw new VaultError(
        'unreadable',
        `record ${id} authenticated but is not [revision, naturalKey, plaintext]`,
      );
    }
    return { revision: asRevision(revision, `record ${id}`), naturalKey, plaintext };
  };

  return {
    recordId,

    encryptRecord: async ({ type, naturalKey, revision, plaintext }) => {
      // A revision that cannot round-trip through `String` would seal a record that never opens again.
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new VaultError(
          'malformed',
          `a revision must be a non-negative safe integer, got ${revision}`,
        );
      }
      const id = await recordId(type, naturalKey);
      const iv = freshIv();
      const body = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: tuple(id, type) },
          recordKey,
          tuple(String(revision), naturalKey, plaintext),
        ),
      );
      return { id, type, ciphertext: sealed(iv, body) };
    },

    decryptRecord: async ({ type, naturalKey, ciphertext }) => {
      const { revision, plaintext } = await open(
        await recordId(type, naturalKey),
        type,
        ciphertext,
      );
      return { revision, plaintext };
    },

    decryptListedRecord: async (type, { id, ciphertext }) => open(id, type, ciphertext),
  };
};
