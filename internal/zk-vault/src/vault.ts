/**
 * `<ns>` is the product's namespace (`vaults`).
 *
 * ```
 * DEK        = random 256 bits
 * wrappedDEK = AES-GCM(encKey, DEK)                          → stored server-side
 * recordKey  = HKDF(DEK, info "<ns>-vault-record")
 * indexKey   = HKDF(DEK, info "<ns>-vault-index")
 * id         = HMAC(indexKey, [type, naturalKey])            → stored server-side
 * ciphertext = AES-GCM(recordKey, [revision, naturalKey, plaintext],
 *                      aad = [id, type])                     → stored server-side
 * fileKey    = HKDF(DEK, info "<ns>-vault-file")
 * file       = iv ‖ AES-GCM(fileKey, bytes, aad = [fileId])   → stored server-side, unencoded
 * localKey   = HKDF(DEK, info <purpose>)                     → never leaves the device
 * ```
 */

import { concat, fromUtf8, toBase64Url, utf8, VaultError } from './bytes.ts';
import { hkdf, type VaultKey } from './keys.ts';
import { freshIv, sealed, unseal, unsealBytes } from './sealed.ts';

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

/**
 * `Purpose` names what a client keeps on its own device, each under its own key: the DEK is never a
 * key itself, and a closed set keeps a purpose from naming the record or index key.
 */
export type Vault<Purpose extends string = never> = {
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
  /** `iv ‖ ciphertext`, bound to `fileId`, so the store cannot answer one file for another. */
  readonly encryptFile: (
    fileId: string,
    bytes: Uint8Array<ArrayBuffer>,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  readonly decryptFile: (fileId: string, stored: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>;
  /** A non-extractable AES-GCM key for what a client stores locally for `purpose`; the same on every open. */
  readonly localKey: (purpose: Purpose) => CryptoKey;
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

export const vaults = <const Purpose extends string = never>({
  namespace,
  localKeyPurposes = [],
}: {
  readonly namespace: string;
  /** Each is an HKDF label in full, so it carries the namespace itself. */
  readonly localKeyPurposes?: readonly Purpose[];
}) => {
  /** An `unreadable` failure here means the wrong password, in password mode. */
  const openVault = async (keys: VaultKey, wrappedDek: string): Promise<Vault<Purpose>> => {
    // WebCrypto cannot re-key an AES-GCM `CryptoKey` into HKDF material, so the DEK passes through as bytes.
    const raw = new Uint8Array(
      await crypto.subtle.exportKey('raw', await unwrap(keys.encKey, wrappedDek)),
    );
    // Derived here, with the others, so the DEK's bytes are dropped once `openVault` returns.
    const [recordKey, indexKey, fileKey, localKeys] = await Promise.all([
      hkdf(raw, `${namespace}-vault-record`, { name: 'AES-GCM', length: 256 }, [
        'encrypt',
        'decrypt',
      ]),
      hkdf(raw, `${namespace}-vault-index`, { name: 'HMAC', hash: 'SHA-256', length: 256 }, [
        'sign',
      ]),
      hkdf(raw, `${namespace}-vault-file`, { name: 'AES-GCM', length: 256 }, [
        'encrypt',
        'decrypt',
      ]),
      Promise.all(
        localKeyPurposes.map(
          async purpose =>
            [
              purpose,
              await hkdf(raw, purpose, { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
            ] as const,
        ),
      ),
    ]);
    const localKeyOf = new Map<Purpose, CryptoKey>(localKeys);

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

      encryptFile: async (fileId, bytes) => {
        const iv = freshIv();
        const body = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: tuple(fileId) },
          fileKey,
          bytes,
        );
        return concat(iv, new Uint8Array(body));
      },

      decryptFile: async (fileId, stored) => {
        const { iv, body } = unsealBytes(stored, `file ${fileId}`);
        const opened = await crypto.subtle
          .decrypt({ name: 'AES-GCM', iv, additionalData: tuple(fileId) }, fileKey, body)
          .catch(() => {
            throw new VaultError('unreadable', `file ${fileId} did not authenticate`);
          });
        return new Uint8Array(opened);
      },

      localKey: purpose => {
        const key = localKeyOf.get(purpose);
        if (key === undefined) throw new VaultError('malformed', `no local key for ${purpose}`);
        return key;
      },
    };
  };

  return {
    createVault: async (
      keys: VaultKey,
    ): Promise<{ readonly vault: Vault<Purpose>; readonly wrappedDek: string }> => {
      const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
        'encrypt',
        'decrypt',
      ]);
      const wrappedDek = await wrap(keys.encKey, generated);
      return { vault: await openVault(keys, wrappedDek), wrappedDek };
    },

    openVault,

    rewrapDek: async (from: VaultKey, to: VaultKey, wrappedDek: string): Promise<string> =>
      wrap(to.encKey, await unwrap(from.encKey, wrappedDek)),
  };
};
