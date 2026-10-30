import type { EncryptedRecord } from '@yozz.app/vault';
import type { ApiErrorCode, PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';

/** What every implementation of `VaultApi` throws, so a refused compare-and-swap reads the same in each client. */
export class VaultApiError extends Error {
  readonly code: ApiErrorCode | 'NETWORK_ERROR';
  readonly status: number;

  constructor(code: ApiErrorCode | 'NETWORK_ERROR', message: string, status = 500) {
    super(message);
    this.name = 'VaultApiError';
    this.code = code;
    this.status = status;
  }
}

/** The vault's record routes, whatever authenticates them. */
export type VaultApi = {
  readonly get: (type: string, id: string) => Promise<VaultRecordEnvelope | null>;
  readonly list: (type: string) => AsyncIterable<VaultRecordEnvelope>;
  /** `revision` is the number sealed in the ciphertext, restated in the clear for CAS; `precondition` omitted is last-write-wins. */
  readonly put: (
    record: EncryptedRecord,
    revision: number,
    precondition?: PutPrecondition,
  ) => Promise<void>;
  readonly remove: (type: string, id: string, ifRevision?: number) => Promise<void>;
};
