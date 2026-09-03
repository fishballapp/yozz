import 'fake-indexeddb/auto';
import { createVault, deriveAccountKeys, type EncryptedRecord } from '@yozz.app/vault';
import type { VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VaultApi } from './api';
import { createRecordStore } from './record-store';

class InMemoryVaultApi implements VaultApi {
  private records = new Map<string, VaultRecordEnvelope>();

  async get(type: string, id: string): Promise<VaultRecordEnvelope | null> {
    const key = `${type}:${id}`;
    return this.records.get(key) ?? null;
  }

  async *list(type: string): AsyncIterable<VaultRecordEnvelope> {
    for (const [key, envelope] of this.records.entries()) {
      if (key.startsWith(`${type}:`)) {
        yield envelope;
      }
    }
  }

  async put(record: EncryptedRecord, revision: number): Promise<void> {
    const key = `${record.type}:${record.id}`;
    this.records.set(key, {
      id: record.id,
      type: record.type,
      ciphertext: record.ciphertext,
      updatedAt: Date.now(),
      revision,
    });
  }

  async remove(type: string, id: string): Promise<void> {
    const key = `${type}:${id}`;
    this.records.delete(key);
  }

  setRaw(type: string, id: string, ciphertext: string, revision: number | null = null): void {
    this.records.set(`${type}:${id}`, {
      id,
      type,
      ciphertext,
      updatedAt: Date.now(),
      revision,
    });
  }
}

describe('RecordStore with freshVault and IndexedDB marks', () => {
  let idbFactory: IDBFactory;

  beforeEach(() => {
    idbFactory = new IDBFactory();
  });

  it('puts, gets, and removes records with client-side encryption and freshness verification', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    await store.put({
      type: 'account',
      naturalKey: 'acc-work',
      plaintext: JSON.stringify({ email: 'work@example.com', name: 'Work Account' }),
    });

    const record1 = await store.get('account', 'acc-work');
    // A throw, not `!`: the runtime check and the type check are one line.
    if (record1 === null) throw new Error('the record was not stored');
    expect(record1.revision).toBe(1);
    expect(JSON.parse(record1.plaintext)).toEqual({
      email: 'work@example.com',
      name: 'Work Account',
    });

    const listed = await store.list('account');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.naturalKey).toBe('acc-work');
    expect(listed[0]?.revision).toBe(1);

    await store.remove('account', 'acc-work');
    expect(await store.get('account', 'acc-work')).toBeNull();

    store.close();
  });

  it('rejects stale replay attacks via persistent high-water mark', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store1 = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    await store1.put({
      type: 'identity',
      naturalKey: 'id-1',
      plaintext: 'Initial Identity',
    });
    const id = await vault.recordId('identity', 'id-1');
    const envelopeRev1 = await api.get('identity', id);
    expect(envelopeRev1).not.toBeNull();

    await store1.put({
      type: 'identity',
      naturalKey: 'id-1',
      plaintext: 'Updated Identity',
    });
    store1.close();

    // The server database is reset to revision 1's ciphertext.
    if (!envelopeRev1) throw new Error('revision 1 was never stored');
    api.setRaw('identity', id, envelopeRev1.ciphertext);

    const store2 = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    await expect(store2.get('identity', 'id-1')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });

    await expect(store2.list('identity')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });

    store2.close();
  });

  it('lets the loser of a CAS race still read the winner', async () => {
    // Marks are per device; allocating from the mark would lock the loser out of its own draft.
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const store = await createRecordStore({ userId: 'user-1', rawVault: vault, api, idbFactory });

    // This device's mark runs well above the shared row.
    for (let i = 0; i < 4; i += 1) {
      await store.put({ type: 'draft', naturalKey: 'k', plaintext: `v${i}` });
    }
    const [row] = await Array.fromAsync(api.list('draft'));
    if (row === undefined) throw new Error('the record was not stored');

    // The other device read the row at 1 and wrote 2.
    await store.put({
      type: 'draft',
      naturalKey: 'k',
      plaintext: 'theirs',
      precondition: { expect: 'revision', revision: row.revision },
    });

    const opened = await store.get('draft', 'k');
    expect(opened?.plaintext).toBe('theirs');
  });

  it('refuses a row whose clear revision disagrees with the sealed one', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const store = await createRecordStore({ userId: 'user-1', rawVault: vault, api, idbFactory });

    await store.put({ type: 'account', naturalKey: 'acc', plaintext: 'hello' });
    // The ciphertext is genuine and seals revision 1; only the column is changed.
    const [stored] = await Array.fromAsync(api.list('account'));
    if (stored === undefined) throw new Error('the record was not stored');
    api.setRaw('account', stored.id, stored.ciphertext, 2);

    await expect(store.get('account', 'acc')).rejects.toMatchObject({
      name: 'VaultStoreDisagreementError',
    });
  });

  it('accepts a pre-CAS row, whose column has nothing to say', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const store = await createRecordStore({ userId: 'user-1', rawVault: vault, api, idbFactory });

    await store.put({ type: 'account', naturalKey: 'acc', plaintext: 'hello' });
    const [stored] = await Array.fromAsync(api.list('account'));
    if (stored === undefined) throw new Error('the record was not stored');
    api.setRaw('account', stored.id, stored.ciphertext, null);

    const opened = await store.get('account', 'acc');
    expect(opened?.plaintext).toBe('hello');
  });

  it('lets a removed record be recreated, which a caller-picked revision could not', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const store = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'first' });
    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'second' });
    await store.remove('account', 'a@b.c');

    // The mark survives the delete, so a recreate has to land above a number `get` can no longer report.
    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'recreated' });

    expect(await store.get('account', 'a@b.c')).toMatchObject({ plaintext: 'recreated' });
    store.close();
  });
});
