/**
 * `@yozz.app/vault` — the browser-side key schedule and record cryptography for the
 * zero-access vault. Every primitive is WebCrypto.
 *
 * The shape it serves: one password derives `authValue` for the server and
 * `encKey` for the browser. `encKey` wraps a
 * DEK, and the DEK is root key material with two labelled HKDF children —
 * `recordKey`, which encrypts one record per item, and `indexKey`, which blind-
 * indexes `[type, naturalKey]` into that record's id. **The children hang off
 * the DEK rather than the password**, so a password change re-wraps 32 bytes
 * and every record stays filed where it was. Spec: ARCHITECTURE.md#keys and
 * ARCHITECTURE.md#2-the-vault--encrypted-records-over-d1.
 *
 * **A read never believes a field the caller could have stated itself.** The
 * store chooses which row answers a lookup, so `decryptRecord` takes the
 * `(type, naturalKey)` pair and computes the id, and `decryptListedRecord`
 * takes the type it was asked for.
 *
 * **The revision is sealed inside the record and every read returns it**, which
 * is how same-row replay becomes detectable: a superseded ciphertext still
 * opens — `[id, type]` cannot tell revisions apart — but it announces the
 * revision it was written at. **`freshVault` is the refusal** — a `Vault`
 * wrapped in a `Vault`, the way `pinnedValidator` wraps a `Validator` — and it
 * still stores nothing: the high-water marks it compares against are the
 * caller's `RevisionMarks`, because a mark supplied by the store being checked
 * would prove nothing. See `vault.ts` for the seal and `fresh.ts` for the
 * refusal.
 *
 * **Nothing here reaches a network or a store.** The server half — Better Auth
 * on Workers + D1, and the rows these records land in — is separate, and this
 * package must stay usable without it: it is the piece that has to be right
 * whether or not the server behaves.
 */
export { VaultError, type VaultFailureCode } from './bytes.ts';
export { freshVault, inMemoryRevisionMarks, type RevisionMarks } from './fresh.ts';
export {
  type AccountKeys,
  deriveAccountKeys,
  derivePasskeyEncKey,
  foldEmail,
  type VaultKey,
} from './keys.ts';
export {
  createVault,
  type EncryptedRecord,
  type OpenedRecord,
  openVault,
  rewrapDek,
  type Vault,
} from './vault.ts';
