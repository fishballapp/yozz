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
