/**
 * The record store's cryptography — one ciphertext per item, blind-indexed.
 *
 * ```
 * DEK        = random 256 bits
 * wrappedDEK = AES-GCM(encKey, DEK)                          → stored server-side
 * recordKey  = HKDF(DEK, info "yozz-vault-record")
 * indexKey   = HKDF(DEK, info "yozz-vault-index")
 * id         = HMAC(indexKey, [type, naturalKey])            → stored server-side
 * ciphertext = AES-GCM(recordKey, [revision, naturalKey, plaintext],
 *                      aad = [id, type])                     → stored server-side
 * ```
 *
 * The DEK is root key material and is never used as a key itself — both of its
 * children are labelled HKDF outputs, for the same reason `encKey` and the
 * index were split: one secret doing two algorithms' work is a smell available
 * at the cost of one more HKDF call.
 *
 * **The DEK exists so a password change re-wraps 32 bytes** instead of
 * re-encrypting every record the user owns. `rewrapDek` is that operation, and
 * it is the reason `indexKey` hangs off the DEK rather than off the password:
 * a record id is a filing address, so it has to outlive the password that
 * filed it. Derived from `masterKey` it would move on every password change,
 * and re-wrapping 32 bytes would leave every record filed at an address the new
 * keys can no longer compute — an O(n) re-index behind an operation the whole
 * DEK exists to keep O(1).
 *
 * **The id is a blind index**: deterministic, so "the record for this account"
 * is a direct key hit rather than a scan, and irreversible, so the server
 * learns nothing from it. Two users' vaults produce different ids for the same
 * natural key, because `indexKey` differs.
 *
 * ## The id in the AEAD, and who is allowed to supply it
 *
 * A ciphertext is sealed with `[id, type]` as AES-GCM's additional data, so it
 * only opens under the id it was filed at. That is the whole substitution
 * defence, and it is worth exactly as much as the id it is checked against.
 *
 * The server is untrusted by construction and it chooses which row answers a
 * lookup. Handed `record.id` from the store, the check is circular: asked for
 * one account and answered with another of the user's OWN rows — genuine id,
 * genuine type, ciphertext that authenticates against them — it opens, and the
 * caller reads one mailbox's credentials as another's. So `decryptRecord`
 * never takes an id. It takes `type` and `naturalKey`, the same pair the
 * lookup used, and computes the id itself; there is nothing for the store to
 * substitute.
 *
 * `decryptListedRecord` is the other read path — "every record of type
 * `account`", where the caller cannot know a natural key going in. It knows the
 * TYPE, though, so the type is a parameter and not a field read off the row:
 * left to the store, an account listing could be answered with a genuine
 * `identity` row, tag intact, and the caller would read an identity's payload
 * from a call whose contract said accounts. What remains store-supplied is the
 * id, which is the one thing the caller genuinely has no expectation for. The
 * natural key comes back out of the ciphertext, authenticated, so which record
 * arrived is a fact rather than an assumption.
 *
 * ## Same-row replay: this package REPORTS the revision, it cannot refuse one
 *
 * `[id, type]` is identical for every revision of one logical record, so a
 * store that keeps a superseded ciphertext and serves it back returns the right
 * record at the wrong point in time — an account's rotated-away mail host or
 * credential, arriving as current.
 *
 * **The revision is sealed INSIDE the record, and every read returns it.** That
 * is what turns "which revision is this?" from a claim the row makes into a
 * fact the ciphertext carries: a store can put any number it likes in a column
 * beside the row, and none of them survive AES-GCM. It sits in the sealed tuple
 * rather than in the additional data for the same reason the natural key does —
 * the additional data binds what the STORE supplies, and a revision is content.
 *
 * **Refusing is the caller's job, and it is not a hedge that it lives there.**
 * A refusal needs a high-water mark per record — "the newest revision this
 * device has seen" — which is state that survives a reload and does not come
 * from the store. This package holds no state by construction. So the split is
 * the same one `@yozz.app/tls` draws for key pinning: the library reports what it
 * observed, the caller owns the store and makes the decision. Binding the
 * store's own `updatedAt` here would have proven nothing, because the store
 * supplies the old timestamp alongside the old ciphertext.
 *
 * **What that leaves open, precisely**: a record this device has never seen has
 * no high-water mark, so a first read is trust-on-first-use — the same shape,
 * and the same accepted limit, as the TOFU pin. And omission is not covered at
 * all: a store that simply withholds a row makes it look deleted, which a
 * per-record mark cannot see. Both are narrower than what was here before,
 * which was every replay of every record, undetectable.
 *
 * **Nothing here talks to a server.** It takes `wrappedDek` in and hands
 * `EncryptedRecord`s out; who stores them, and the `updatedAt` the envelope
 * carries beside them, is the layer above. There is deliberately no device
 * identifier in that envelope: nothing read one, and a stable per-browser id on
 * every write is a per-record device fingerprint bought for no feature.
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

/** RFC 5116 §5.1's nonce length for AES-GCM, and WebCrypto's only safe choice. */
const IV_BYTES = 12;

/**
 * What the store holds for one item. `type` and `id` are in the clear —
 * ARCHITECTURE.md accepts that the server sees record counts, sizes and
 * modification times. A store may rewrite either column; what it cannot do is
 * make a read believe the rewrite, since both are inputs to the AEAD and
 * neither is taken from the row on the way back.
 */
export type EncryptedRecord = {
  readonly id: string;
  readonly type: string;
  /** base64 of `iv ‖ AES-GCM(recordKey, [revision, naturalKey, plaintext])`. */
  readonly ciphertext: string;
};

/**
 * What a read establishes about a record. The revision is here rather than
 * enforced inside because refusing a stale one needs a per-record high-water
 * mark, and this package holds no state — see the same-row replay note above.
 * Returned in a shape the caller has to destructure, which is the most a
 * library that owns no store can do to keep the check from being skipped.
 */
export type OpenedRecord = {
  readonly revision: number;
  readonly plaintext: string;
};

export type Vault = {
  /** The id to look a record up under, without decrypting anything. */
  readonly recordId: (type: string, naturalKey: string) => Promise<string>;
  /**
   * `revision` is the caller's: it read the previous one and writes one above
   * it. Nothing here can supply it, because a counter is only monotonic against
   * a store this package cannot see.
   */
  readonly encryptRecord: (item: {
    readonly type: string;
    readonly naturalKey: string;
    readonly revision: number;
    readonly plaintext: string;
  }) => Promise<EncryptedRecord>;
  /**
   * The direct hit. It takes the pair the lookup used rather than an id,
   * because an id from the store is an id the store chose.
   */
  readonly decryptRecord: (item: {
    readonly type: string;
    readonly naturalKey: string;
    readonly ciphertext: string;
  }) => Promise<OpenedRecord>;
  /**
   * Enumeration, for the caller that fetched every row of a type and knows no
   * natural key going in. The natural key comes back authenticated, so which
   * record arrived is a fact rather than an assumption.
   */
  readonly decryptListedRecord: (
    type: string,
    listed: { readonly id: string; readonly ciphertext: string },
  ) => Promise<OpenedRecord & { readonly naturalKey: string }>;
};

/**
 * JSON rather than a separator, because the parts are caller strings and
 * `${type}:${naturalKey}` is not injective — a type of `account:x` with a
 * natural key of `y` collides with `account` and `x:y`, and a blind index that
 * collides hands one record's row to another record's lookup.
 */
const tuple = (...parts: readonly string[]): Uint8Array<ArrayBuffer> => utf8(JSON.stringify(parts));

/**
 * The inverse, and total. These bytes have already passed AES-GCM, so anything
 * malformed here is our own bug rather than an attack — which is exactly why it
 * gets a typed refusal instead of a raw `SyntaxError` from `JSON.parse`.
 */
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

/**
 * A revision has to ORDER, and the tuple carries strings — `"10" < "9"` is
 * true, and a comparison that silently reverses is the whole freshness check
 * failing open. So it round-trips through `String` on the way out and is
 * checked to round-trip back: that rejects `""`, `" 1"`, `"01"` and `"1e3"`,
 * each of which is a number `Number()` would happily accept and no two writers
 * would agree on.
 */
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

/**
 * Random rather than a counter, which is the only choice available: several
 * devices write to one vault under one DEK and none of them can see the
 * others' writes, so no counter they keep is safe to reuse.
 *
 * The bound that comes with it: NIST SP 800-38D caps a key at ~2^32
 * invocations under random 96-bit nonces before a repeat becomes likely, and a
 * repeat under AES-GCM is a total break of both records. Four billion record
 * writes per DEK, against a vault holding accounts and identities. If a record
 * type ever writes per message rather than per account, the upgrade is a DEK
 * rotation on a write counter, not a longer nonce.
 */
const freshIv = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(IV_BYTES));

const wrap = async (encKey: CryptoKey, dek: CryptoKey): Promise<string> => {
  const iv = freshIv();
  return sealed(
    iv,
    new Uint8Array(await crypto.subtle.wrapKey('raw', dek, encKey, { name: 'AES-GCM', iv })),
  );
};

/**
 * Always EXTRACTABLE, and both callers need it for their own reason:
 * `openVault` reads the raw bytes to derive the DEK's two children, and
 * `rewrapDek` hands the key to `wrapKey`, which refuses one that is not.
 * Neither handle escapes the function that made it, and no `Vault` ever holds
 * one — what a vault holds is the two non-extractable children.
 */
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

/**
 * A fresh vault: a new DEK, wrapped, and then opened through the ordinary path.
 * Going back through `openVault` rather than deriving the children here is what
 * makes a fresh vault and a reopened one the same object built the same way —
 * and it means a `wrappedDek` this function returns has been proven to open
 * before a single record is written under it.
 */
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

/**
 * Re-seal the same DEK under keys derived from a new password, which is the
 * whole reason a DEK exists: 32 bytes move and not one record is rewritten.
 *
 * Record ids do not move either, and that is the half worth checking — they
 * hang off the DEK, so a password change leaves every record exactly where it
 * was filed.
 */
export const rewrapDek = async (
  from: VaultKey,
  to: VaultKey,
  wrappedDek: string,
): Promise<string> => wrap(to.encKey, await unwrap(from.encKey, wrappedDek));

/**
 * Unwrap the DEK and hand back the operations that need it. A `VaultError` with
 * code `unreadable` here means the password or the device secret is wrong —
 * those are the two inputs `encKey` is made of, and AES-GCM cannot tell them
 * apart.
 */
export const openVault = async (keys: VaultKey, wrappedDek: string): Promise<Vault> => {
  /**
   * The DEK exists here as bytes rather than as a key, because WebCrypto cannot
   * re-key an AES-GCM `CryptoKey` into HKDF material and both children are HKDF
   * over it. The two children are non-extractable and the DEK itself is never
   * used to encrypt anything.
   */
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

  /**
   * Both read paths. What differs is only how much of `[id, type]` the CALLER
   * supplied, and that is the entire security difference between them.
   *
   * There is deliberately no second check that the sealed natural key
   * re-derives `id`. It cannot fail: `id` is `HMAC(indexKey, [type,
   * naturalKey])` over the very natural key inside, so any row the additional
   * data lets through already satisfies it. An assertion nothing can trip is
   * noise in a security path, and a mutation run is what showed it — disabling
   * it changed no result.
   */
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
      // Names the SHAPE rather than one field: a pre-revision two-tuple binds
      // `revision` to the natural key and leaves `plaintext` undefined, so
      // "carries no natural key" would point a reader at the one part that is
      // present.
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
      /**
       * At the door, not at the read: a revision that cannot round-trip writes
       * a record that never opens again, and the symptom would surface one
       * fetch later as "did not authenticate" with nothing pointing here.
       */
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
