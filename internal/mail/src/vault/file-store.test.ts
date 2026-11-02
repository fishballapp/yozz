import { createVault, deriveAccountKeys, VaultError } from '@yozz.app/vault';
import type { ListFilesResponse } from '@yozz.app/vault-contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeFileStore } from '../testing/fake-file-store.ts';
import { VaultApiError, type VaultFileApi } from './api.ts';
import { createFileStore } from './file-store.ts';

const FILE_A = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const FILE_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const FILE_C = '9b2d5f3e-1a4c-4e8b-8f6d-3c7a1e5b9d20';

/** The Worker as a client sees it, holding what it is handed; `pageSize` pages the listing. */
const memoryFileApi = (pageSize = 100) => {
  const held = new Map<string, Uint8Array<ArrayBuffer>>();
  const api: VaultFileApi = {
    putFile: async (fileId, ciphertext) => {
      held.set(fileId, ciphertext);
    },
    getFile: async fileId => held.get(fileId) ?? null,
    listFiles: async (after): Promise<ListFilesResponse> => {
      const ids = [...held.keys()].sort().filter(id => after === undefined || id > after);
      const page = ids.slice(0, pageSize);
      return {
        files: page.map(id => ({ id, size: held.get(id)?.length ?? 0, createdAt: 1000 })),
        nextCursor: ids.length > pageSize ? (page.at(-1) ?? null) : null,
        usedBytes: [...held.values()].reduce((sum, bytes) => sum + bytes.length, 0),
        capBytes: 1024,
      };
    },
    removeFile: async fileId => {
      held.delete(fileId);
    },
  };
  return { api, held };
};

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

describe('createFileStore', () => {
  let vault: Awaited<ReturnType<typeof createVault>>['vault'];

  beforeAll(async () => {
    const keys = await deriveAccountKeys({ email: 'a@example.com', password: 'a password' });
    ({ vault } = await createVault(keys));
  });

  it('round-trips a file, and the server only ever holds ciphertext', async () => {
    const { api, held } = memoryFileApi();
    const store = createFileStore({ vault, api });
    const plaintext = bytesOf('the secret attachment');

    await store.put(FILE_A, plaintext);

    const onServer = new TextDecoder().decode(held.get(FILE_A));
    expect(onServer).not.toContain('secret');
    expect(await store.get(FILE_A)).toEqual(plaintext);
  });

  it('answers null for a file that is not there, and removes one', async () => {
    const { api } = memoryFileApi();
    const store = createFileStore({ vault, api });
    await store.put(FILE_A, bytesOf('x'));

    await store.remove(FILE_A);

    expect(await store.get(FILE_A)).toBeNull();
    await expect(store.remove(FILE_A)).resolves.toBeUndefined();
  });

  it('refuses a server that answers one file for another', async () => {
    const { api, held } = memoryFileApi();
    const store = createFileStore({ vault, api });
    await store.put(FILE_A, bytesOf('for alice'));
    await store.put(FILE_B, bytesOf('for bob'));
    const a = held.get(FILE_A);
    if (a === undefined) throw new Error('FILE_A was not stored');

    held.set(FILE_B, a);

    await expect(store.get(FILE_B)).rejects.toBeInstanceOf(VaultError);
  });

  it('walks every page of the listing', async () => {
    const { api } = memoryFileApi(1);
    const store = createFileStore({ vault, api });
    await store.put(FILE_A, bytesOf('a'));
    await store.put(FILE_B, bytesOf('b'));
    await store.put(FILE_C, bytesOf('c'));

    const listing = await store.list();

    expect(listing.files.map(({ id }) => id).sort()).toEqual([FILE_A, FILE_B, FILE_C].sort());
    expect(listing.capBytes).toBe(1024);
    expect(listing.usedBytes).toBe(listing.files.reduce((sum, { size }) => sum + size, 0));
  });
});

describe('fakeFileStore', () => {
  it('refuses what the Worker refuses', async () => {
    const { store } = fakeFileStore({ capBytes: 4 });
    await store.put(FILE_A, bytesOf('abc'));

    await expect(store.put(FILE_A, bytesOf('d'))).rejects.toMatchObject({ code: 'CONFLICT' });
    const full = await store.put(FILE_B, bytesOf('de')).catch((error: unknown) => error);
    expect(full).toBeInstanceOf(VaultApiError);
    expect(full).toMatchObject({ code: 'STORAGE_FULL' });
  });
});
