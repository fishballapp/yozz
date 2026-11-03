import 'fake-indexeddb/auto';
import { VaultApiError, type VaultRecordApi } from '@yozz.app/mail/vault/api';
import { createVault, deriveAccountKeys, type EncryptedRecord, type Vault } from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDeviceRecordStore } from '../vault/device-record-store';
import { forgetConsent, readConsents, rememberConsent } from './remote-images';

/** The Worker's record routes as far as consents use them: compare-and-swap, or last write wins. */
const casVaultApi = () => {
  const rows = new Map<string, VaultRecordEnvelope>();
  const state = { failNextPut: false };
  const api: VaultRecordApi = {
    get: async (type, id) => rows.get(`${type}:${id}`) ?? null,
    list: async function* () {},
    put: async (record: EncryptedRecord, revision: number, precondition?: PutPrecondition) => {
      if (state.failNextPut) {
        state.failNextPut = false;
        throw new TypeError('Failed to fetch');
      }
      const key = `${record.type}:${record.id}`;
      const existing = rows.get(key);
      const isRefused =
        (precondition?.expect === 'absent' && existing !== undefined) ||
        (precondition?.expect === 'revision' && existing?.revision !== precondition.revision);
      if (isRefused) throw new VaultApiError('CONFLICT', 'Record revision is stale', 409);
      rows.set(key, { ...record, updatedAt: Date.now(), revision });
    },
    remove: async () => {},
  };
  return { api, state };
};

const consent = (n: number) => ({ messageId: `mid/<${n}@x>`, sender: 'a@x.example' });
const ids = (consents: readonly { messageId: string }[]) => consents.map(c => c.messageId);

describe('consents over the real record store, after a write that never reached the server', () => {
  let vault: Vault;
  beforeAll(async () => {
    ({ vault } = await createVault(
      await deriveAccountKeys({ email: 'u@example.com', password: 'password123456' }),
    ));
  });

  /** One device: its revision marks persist in its IndexedDB across a reload. */
  const device = () => {
    const idbFactory = new IDBFactory();
    const { api, state } = casVaultApi();
    const open = () => openDeviceRecordStore({ userId: 'u1', vault, api, idbFactory });
    return { open, state };
  };

  it('keeps adding and forgetting in the same session, losing only what failed', async () => {
    const { open, state } = device();
    const store = await open();
    await rememberConsent(store, consent(1));
    state.failNextPut = true;
    await expect(rememberConsent(store, consent(2))).rejects.toThrow('Failed to fetch');
    expect(ids((await readConsents(store)).consents)).toEqual(['mid/<1@x>']);

    await rememberConsent(store, consent(3));
    await forgetConsent(store, consent(1));
    expect(ids((await readConsents(store)).consents)).toEqual(['mid/<3@x>']);
    store.close();
  });

  it('reads the list after a reload, keeping what was confirmed', async () => {
    const { open, state } = device();
    const store = await open();
    await rememberConsent(store, consent(1));
    state.failNextPut = true;
    await expect(rememberConsent(store, consent(2))).rejects.toThrow();
    store.close();

    const reopened = await open();
    expect(ids((await readConsents(reopened)).consents)).toEqual(['mid/<1@x>']);
    await rememberConsent(reopened, consent(4));
    expect(ids((await readConsents(reopened)).consents)).toEqual(['mid/<1@x>', 'mid/<4@x>']);
    reopened.close();
  });
});
