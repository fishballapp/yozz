import type { Vault } from '@yozz.app/vault';
import type { VaultFileSummary } from '@yozz.app/vault-contract';
import type { VaultFileApi } from './api.ts';

export type FileListing = {
  readonly files: readonly VaultFileSummary[];
  readonly usedBytes: number;
  readonly capBytes: number;
};

export type FileStore = {
  /** `fileId` is a random UUID. A file is never replaced: a retry takes a new id. */
  readonly put: (fileId: string, bytes: Uint8Array<ArrayBuffer>) => Promise<void>;
  /** A file that does not open under `fileId` throws `VaultError`, whatever the server answered. */
  readonly get: (fileId: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  readonly list: () => Promise<FileListing>;
  readonly remove: (fileId: string) => Promise<void>;
};

/** The files beside the records: no revision marks, since a file never changes under its id. */
export const createFileStore = ({
  vault,
  api,
}: {
  readonly vault: Vault;
  readonly api: VaultFileApi;
}): FileStore => {
  const list = async (after?: string): Promise<FileListing> => {
    const { files, nextCursor, usedBytes, capBytes } = await api.listFiles(after);
    if (nextCursor === null) return { files, usedBytes, capBytes };
    const rest = await list(nextCursor);
    return { ...rest, files: [...files, ...rest.files] };
  };

  return {
    put: async (fileId, bytes) => api.putFile(fileId, await vault.encryptFile(fileId, bytes)),
    get: async fileId => {
      const stored = await api.getFile(fileId);
      return stored === null ? null : vault.decryptFile(fileId, stored);
    },
    list: () => list(),
    remove: fileId => api.removeFile(fileId),
  };
};
