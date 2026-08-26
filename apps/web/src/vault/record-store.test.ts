import 'fake-indexeddb/auto';
import {
  createDeviceSecret,
  createVault,
  deriveAccountKeys,
  type EncryptedRecord,
} from '@yozz.app/vault';
import type { VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { VaultApi } from './api.ts';
import { createRecordStore } from './record-store.ts';

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

  async put(record: EncryptedRecord): Promise<void> {
    const key = `${record.type}:${record.id}`;
    this.records.set(key, {
      id: record.id,
      type: record.type,
      ciphertext: record.ciphertext,
      updatedAt: Date.now(),
    });
  }

  async remove(type: string, id: string): Promise<void> {
    const key = `${type}:${id}`;
    this.records.delete(key);
  }

  setRaw(type: string, id: string, ciphertext: string): void {
    this.records.set(`${type}:${id}`, {
      id,
      type,
      ciphertext,
      updatedAt: Date.now(),
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
      password: 'password123',
      deviceSecret: createDeviceSecret(),
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    // Put record rev 1
    await store.put({
      type: 'account',
      naturalKey: 'acc-work',
      plaintext: JSON.stringify({ email: 'work@example.com', name: 'Work Account' }),
    });

    // Get record
    const record1 = await store.get('account', 'acc-work');
    // Narrowed with a throw rather than `!` — the repo forbids non-null
    // assertions, and this way the runtime check and the type check are the
    // same line instead of two that can drift.
    if (record1 === null) throw new Error('the record was not stored');
    expect(record1.revision).toBe(1);
    expect(JSON.parse(record1.plaintext)).toEqual({
      email: 'work@example.com',
      name: 'Work Account',
    });

    // List records
    const listed = await store.list('account');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.naturalKey).toBe('acc-work');
    expect(listed[0]?.revision).toBe(1);

    // Remove record
    await store.remove('account', 'acc-work');
    expect(await store.get('account', 'acc-work')).toBeNull();

    store.close();
  });

  it('rejects stale replay attacks via persistent high-water mark', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123',
      deviceSecret: createDeviceSecret(),
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store1 = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    // Put revision 1 and save its ciphertext
    await store1.put({
      type: 'identity',
      naturalKey: 'id-1',
      plaintext: 'Initial Identity',
    });
    const id = await vault.recordId('identity', 'id-1');
    const envelopeRev1 = await api.get('identity', id);
    expect(envelopeRev1).not.toBeNull();

    // Put revision 2
    await store1.put({
      type: 'identity',
      naturalKey: 'id-1',
      plaintext: 'Updated Identity',
    });
    store1.close();

    // Attacker resets server database to ciphertext of revision 1
    if (!envelopeRev1) throw new Error('revision 1 was never stored');
    api.setRaw('identity', id, envelopeRev1.ciphertext);

    // Open store on the same device with existing IndexedDB marks
    const store2 = await createRecordStore({
      userId: 'user-1',
      rawVault: vault,
      api,
      idbFactory,
    });

    // Fetching the replayed revision 1 MUST throw VaultError with code 'stale'
    await expect(store2.get('identity', 'id-1')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });

    // Listing that includes replayed revision 1 MUST reject the whole list
    await expect(store2.list('identity')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });

    store2.close();
  });

  it('lets a removed record be recreated, which a caller-picked revision could not', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123',
      deviceSecret: createDeviceSecret(),
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

    // The mark survives the delete on purpose — clearing it would let a store
    // that withholds a row reset this device to TOFU and replay. So a recreate
    // has to land ABOVE a number `get` can no longer report, which is exactly
    // why `put` allocates from the mark instead of taking one.
    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'recreated' });

    expect(await store.get('account', 'a@b.c')).toMatchObject({ plaintext: 'recreated' });
    store.close();
  });
});
