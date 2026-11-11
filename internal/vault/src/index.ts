/**
 * YOZZ's vault: `@internal/zk-vault` under YOZZ's namespace. The namespace is in every
 * key-derivation label, so it never changes (`compat.test.ts`).
 */

import {
  openCliLogin as openSealedLogin,
  type Vault as SchemeVault,
  sealCliLogin as sealLogin,
  VaultError,
  zkVault,
} from '@internal/zk-vault';
import { type CliLoginPayload, CliLoginPayloadSchema } from '@yozz.app/vault-contract';

export {
  type AccountKeys,
  type CliKeys,
  type EncodedKeyPair as CliKeyPair,
  type EncryptedRecord,
  foldEmail,
  freshVault,
  generateKeyPair as generateCliKeyPair,
  inMemoryRevisionMarks,
  type OpenedRecord,
  pairingCode,
  type RevisionMarks,
  VaultError,
  type VaultFailureCode,
  type VaultKey,
} from '@internal/zk-vault';

/** What a client keeps on its own device, each under its own key. */
export type LocalKeyPurpose = 'yozz-cli-cache';

export type Vault = SchemeVault<LocalKeyPurpose>;

export const {
  createVault,
  deriveAccountKeys,
  deriveApprovalKeys,
  deriveCliKeys,
  derivePasskeyEncKey,
  openVault,
  rewrapDek,
} = zkVault({ namespace: 'yozz', localKeyPurposes: ['yozz-cli-cache'] });

export const sealCliLogin = (
  tokenKey: CryptoKey,
  login: { readonly state: string; readonly payload: CliLoginPayload },
): Promise<string> => sealLogin(tokenKey, login);

export const openCliLogin = async (
  tokenKey: CryptoKey,
  sealed: { readonly state: string; readonly sealedLogin: string },
): Promise<CliLoginPayload> => {
  const payload = CliLoginPayloadSchema.safeParse(await openSealedLogin(tokenKey, sealed));
  if (!payload.success) {
    throw new VaultError('unreadable', 'the sealed login authenticated but is not a login');
  }
  return payload.data;
};
