import { type CliKeys, cliKeys, openCliLogin, sealCliLogin } from './cli-key.ts';
import { vaultKeys } from './keys.ts';
import { vaults } from './vault.ts';

export { openBox, openVouched, sealBox, sealVouched } from './box.ts';
export {
  concat,
  fromBase64,
  fromUtf8,
  toBase64,
  toBase64Url,
  utf8,
  VaultError,
  type VaultFailureCode,
} from './bytes.ts';
export { freshVault, inMemoryRevisionMarks, type RevisionMarks } from './fresh.ts';
export { type AccountKeys, foldEmail, hkdf, hkdfBytes, type VaultKey } from './keys.ts';
export { freshIv, sealed, unseal } from './sealed.ts';
export type { EncryptedRecord, OpenedRecord, Vault } from './vault.ts';
export {
  decodePublicKey,
  type EncodedKeyPair,
  generateKeyPair,
  importPrivateKey,
  type PrivateKey,
  pairingCode,
  privateKeyFromBytes,
} from './x25519.ts';
export { type CliKeys, openCliLogin, sealCliLogin };

/**
 * One product's vault scheme. `namespace` prefixes every key-derivation label, so it is fixed for
 * the life of the data: changing it makes every stored vault unreadable.
 */
export const zkVault = <const Purpose extends string = never>(scheme: {
  readonly namespace: string;
  readonly localKeyPurposes?: readonly Purpose[];
}) => ({
  ...vaultKeys(scheme.namespace),
  ...vaults(scheme),
  ...cliKeys(scheme.namespace),
});
