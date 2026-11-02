import { MAX_STORED_BYTES_PER_USER } from '@yozz.app/vault-contract';
import { VaultApiError } from '../vault/api.ts';
import type { FileStore } from '../vault/file-store.ts';

/**
 * A file store that ENFORCES what the Worker does: a file is never replaced and the cap holds. A
 * store that accepted everything would hide the refusals a client has to handle. Sizes here are the
 * plaintext's, since nothing is sealed.
 */
export const fakeFileStore = ({
  capBytes = MAX_STORED_BYTES_PER_USER,
}: {
  readonly capBytes?: number;
} = {}) => {
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; createdAt: number }>();
  const usedBytes = () => [...files.values()].reduce((sum, { bytes }) => sum + bytes.length, 0);
  const store: FileStore = {
    put: async (fileId, bytes) => {
      if (files.has(fileId)) throw new VaultApiError('CONFLICT', 'A file is never replaced', 409);
      if (usedBytes() + bytes.length > capBytes) {
        throw new VaultApiError('STORAGE_FULL', 'File storage is full', 413);
      }
      files.set(fileId, { bytes, createdAt: Date.now() });
    },
    get: async fileId => files.get(fileId)?.bytes ?? null,
    list: async () => ({
      files: [...files].map(([id, { bytes, createdAt }]) => ({
        id,
        size: bytes.length,
        createdAt,
      })),
      usedBytes: usedBytes(),
      capBytes,
    }),
    remove: async fileId => {
      files.delete(fileId);
    },
  };
  return { store, files };
};
