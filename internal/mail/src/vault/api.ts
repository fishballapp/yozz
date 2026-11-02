import type { EncryptedRecord } from '@yozz.app/vault';
import type {
  ApiErrorCode,
  ListFilesResponse,
  PutPrecondition,
  VaultRecordEnvelope,
} from '@yozz.app/vault-contract';

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
export type VaultRecordApi = {
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

/** The vault's file routes, whatever authenticates them. The bytes are already sealed. */
export type VaultFileApi = {
  /** A refusal comes back as `VaultApiError`: `CONFLICT`, `FILE_TOO_LARGE` or `STORAGE_FULL`. */
  readonly putFile: (fileId: string, ciphertext: Uint8Array<ArrayBuffer>) => Promise<void>;
  readonly getFile: (fileId: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  readonly listFiles: (after?: string) => Promise<ListFilesResponse>;
  /** Deleting nothing succeeds. */
  readonly removeFile: (fileId: string) => Promise<void>;
};

export type VaultApi = VaultRecordApi & VaultFileApi;
