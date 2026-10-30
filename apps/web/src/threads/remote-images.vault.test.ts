import 'fake-indexeddb/auto';
import { type VaultApi, VaultApiError } from '@yozz.app/mail/vault/api';
import { createVault, deriveAccountKeys, type EncryptedRecord, type Vault } from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { openDeviceRecordStore } from '../vault/device-record-store';
import {
  forgetConsent,
  MAX_REMEMBERED_ID_LENGTH,
  readConsents,
  rememberConsent,
} from './remote-images';

/** The Worker's record routes as far as consents use them: compare-and-swap, or last write wins. */
const casVaultApi = () => {
  const rows = new Map<string, VaultRecordEnvelope>();
  const state = { failNextPut: false };
  const api: VaultApi = {
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

  it('keeps adding and forgetting in the same session', async () => {
    const { open, state } = device();
    const store = await open();
    await rememberConsent(store, consent(1), () => [consent(1)]);
    state.failNextPut = true;
    await expect(
      rememberConsent(store, consent(2), () => [consent(1), consent(2)]),
    ).rejects.toThrow('Failed to fetch');
    // The failed write raised this device's mark past the server's row.
    await expect(readConsents(store)).rejects.toThrow('stale');

    await rememberConsent(store, consent(3), () => [consent(1), consent(2), consent(3)]);
    await forgetConsent(store, consent(1), () => [consent(2), consent(3)]);
    expect(ids((await readConsents(store)).consents)).toEqual(['mid/<2@x>', 'mid/<3@x>']);
    store.close();

    const reopened = await open();
    expect(ids((await readConsents(reopened)).consents)).toEqual(['mid/<2@x>', 'mid/<3@x>']);
    reopened.close();
  });

  it('recovers after a reload, from what the new session holds', async () => {
    const { open, state } = device();
    const store = await open();
    await rememberConsent(store, consent(1), () => [consent(1)]);
    state.failNextPut = true;
    await expect(
      rememberConsent(store, consent(2), () => [consent(1), consent(2)]),
    ).rejects.toThrow();
    store.close();

    const reopened = await open();
    await expect(readConsents(reopened)).rejects.toThrow('stale');
    await rememberConsent(reopened, consent(4), () => [consent(4)]);
    expect(ids((await readConsents(reopened)).consents)).toEqual(['mid/<4@x>']);
    await forgetConsent(reopened, consent(4), () => []);
    expect(ids((await readConsents(reopened)).consents)).toEqual([]);
    reopened.close();
  });

  it('leaves a session-only id out of the list it recovers with', async () => {
    const { open, state } = device();
    const store = await open();
    await rememberConsent(store, consent(1), () => [consent(1)]);
    state.failNextPut = true;
    await expect(rememberConsent(store, consent(2), () => [])).rejects.toThrow();

    const long = {
      messageId: `mid/<${'x'.repeat(MAX_REMEMBERED_ID_LENGTH)}@x>`,
      sender: 'a@x.example',
    };
    await rememberConsent(store, consent(3), () => [consent(1), long, consent(3)]);
    expect(ids((await readConsents(store)).consents)).toEqual(['mid/<1@x>', 'mid/<3@x>']);
    store.close();
  });
});
