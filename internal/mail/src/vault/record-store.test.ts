import {
  createVault,
  deriveAccountKeys,
  type EncryptedRecord,
  inMemoryRevisionMarks,
  type RevisionMarks,
} from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_LEASE_RECORD_TYPE } from '../compose/draft-record.ts';
import {
  advanceSend,
  claimSend,
  createDraft,
  keepSendLease,
  listDrafts,
  purgeSendLeases,
  readSendLease,
  replaceDraft,
} from '../compose/draft-vault.ts';
import { VaultApiError, type VaultRecordApi } from './api.ts';
import { createRecordStore } from './record-store.ts';

class InMemoryVaultApi implements VaultRecordApi {
  private records = new Map<string, VaultRecordEnvelope>();
  /** A PUT that never reached the server. */
  isOffline = false;
  /** A PUT the server stored, whose answer never came back. */
  isAnswerLost = false;
  /** A hostile store: answers yes and keeps what it had. */
  isDroppingWrites = false;
  /** A PUT that never comes back, as for a tab that dies while it is on the wire. */
  isHanging = false;
  hungPuts = 0;

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

  async put(
    record: EncryptedRecord,
    revision: number,
    precondition?: PutPrecondition,
  ): Promise<void> {
    if (this.isOffline) throw new Error('network down');
    if (this.isHanging) {
      this.hungPuts += 1;
      await new Promise(() => undefined);
    }
    if (this.isDroppingWrites) return;
    const key = `${record.type}:${record.id}`;
    const existing = this.records.get(key);
    const isRefused =
      (precondition?.expect === 'absent' && existing !== undefined) ||
      (precondition?.expect === 'revision' && existing?.revision !== precondition.revision);
    if (isRefused) throw new VaultApiError('CONFLICT', 'Record revision is stale', 409);
    this.records.set(key, {
      id: record.id,
      type: record.type,
      ciphertext: record.ciphertext,
      updatedAt: Date.now(),
      revision,
    });
    if (this.isAnswerLost) throw new Error('connection lost');
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

describe('RecordStore with freshVault and revision marks', () => {
  // One device: every store a test opens shares its marks, as two unlocks on one machine do.
  let marks: RevisionMarks;

  beforeEach(() => {
    marks = inMemoryRevisionMarks();
  });

  it('puts, gets, and removes records with client-side encryption and freshness verification', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store = createRecordStore({ vault, api, marks });

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
  });

  it('rejects stale replay attacks via persistent high-water mark', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();

    const store1 = createRecordStore({ vault, api, marks });

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

    // The server database is reset to revision 1's ciphertext.
    if (!envelopeRev1) throw new Error('revision 1 was never stored');
    api.setRaw('identity', id, envelopeRev1.ciphertext);

    const store2 = createRecordStore({ vault, api, marks });

    await expect(store2.get('identity', 'id-1')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });

    await expect(store2.list('identity')).rejects.toMatchObject({
      name: 'VaultError',
      code: 'stale',
    });
  });

  it('lets the loser of a CAS race still read the winner', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const loser = createRecordStore({ vault, api, marks });
    const winner = createRecordStore({ vault, api, marks: inMemoryRevisionMarks() });
    const atRevisionOne = { expect: 'revision', revision: 1 } as const;
    await loser.put({ type: 'draft', naturalKey: 'k', plaintext: 'v0' });

    await winner.put({
      type: 'draft',
      naturalKey: 'k',
      plaintext: 'theirs',
      precondition: atRevisionOne,
    });
    await expect(
      loser.put({ type: 'draft', naturalKey: 'k', plaintext: 'mine', precondition: atRevisionOne }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await loser.get('draft', 'k')).toMatchObject({ plaintext: 'theirs', revision: 2 });
  });

  it("allocates a compare-and-swap write from the row, not this device's mark", async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const seen = createRecordStore({ vault, api, marks });
    const unseen = createRecordStore({ vault, api, marks: inMemoryRevisionMarks() });
    await seen.put({ type: 'draft', naturalKey: 'k', plaintext: 'v0' });

    await unseen.put({
      type: 'draft',
      naturalKey: 'k',
      plaintext: 'next',
      precondition: { expect: 'revision', revision: 1 },
    });

    expect(await seen.get('draft', 'k')).toMatchObject({ plaintext: 'next', revision: 2 });
  });

  it('refuses a row whose clear revision disagrees with the sealed one', async () => {
    const keys = await deriveAccountKeys({
      email: 'user@example.com',
      password: 'password123456',
    });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const store = createRecordStore({ vault, api, marks });

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
    const store = createRecordStore({ vault, api, marks });

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
    const store = createRecordStore({ vault, api, marks });

    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'first' });
    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'second' });
    await store.remove('account', 'a@b.c');

    // The mark survives the delete, so a recreate has to land above a number `get` can no longer report.
    await store.put({ type: 'account', naturalKey: 'a@b.c', plaintext: 'recreated' });

    expect(await store.get('account', 'a@b.c')).toMatchObject({ plaintext: 'recreated' });
  });
});

describe('a send lease on the real store', () => {
  const opened = async () => {
    const keys = await deriveAccountKeys({ email: 'user@example.com', password: 'password123456' });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const marks = inMemoryRevisionMarks();
    // A reload: a new store over the same device's marks.
    const reload = () => createRecordStore({ vault, api, marks });
    return { api, marks, reload, vault };
  };

  const CONTENT = {
    from: 'me@x.co',
    to: 'you@x.co',
    cc: '',
    bcc: '',
    subject: 'Hi',
    body: 'Hello',
  };

  const claimed = async (store: ReturnType<typeof createRecordStore>) => {
    const created = await createDraft(store, CONTENT, 0);
    if (!created.ok) throw new Error('the fixture could not create a draft');
    const claim = await claimSend(store, created.handle.draftId, {
      messageId: '<m@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
    });
    if (!claim.ok) throw new Error('the fixture could not claim');
    return claim.handle;
  };

  const renew = (store: ReturnType<typeof createRecordStore>, renewedAt: number) =>
    store.put({
      type: SEND_LEASE_RECORD_TYPE,
      naturalKey: 'op-1',
      plaintext: JSON.stringify({ renewedAt }),
    });

  it('keeps a device loading its drafts after a failed renewal and a dead tab, and sweeps the row', async () => {
    const { api, reload } = await opened();
    const tab = reload();
    const { record } = await claimed(tab);
    await renew(tab, 1_000);

    api.isOffline = true;
    await expect(renew(tab, 46_000)).rejects.toThrow('network down');
    api.isOffline = false;

    // The tab dies, and nobody ever writes that row again.
    const next = reload();
    const [listed] = await listDrafts(next);
    expect(listed?.renewedAt).toBe(1_000);
    expect(await readSendLease(next, record)).toBe(1_000);
    await purgeSendLeases(next, 1_000_000);
    expect(await next.list(SEND_LEASE_RECORD_TYPE)).toEqual([]);
    expect(await listDrafts(next)).toHaveLength(1);
  });

  it('keeps a live tab reading between a failed beat and the next good one', async () => {
    const { api, reload } = await opened();
    const tab = reload();
    await claimed(tab);
    await renew(tab, 1_000);
    api.isOffline = true;
    await renew(tab, 46_000).catch(() => undefined);
    api.isOffline = false;

    expect((await listDrafts(tab))[0]?.renewedAt).toBe(1_000);
    await renew(tab, 91_000);
    expect((await listDrafts(tab))[0]?.renewedAt).toBe(91_000);
  });

  it('keeps no marks for a lease, and still marks everything else', async () => {
    const { marks, reload, vault } = await opened();
    const tab = reload();
    await claimed(tab);
    await renew(tab, 1_000);
    expect(await marks.highWaterMark(await vault.recordId(SEND_LEASE_RECORD_TYPE, 'op-1'))).toBe(
      undefined,
    );
    await tab.list(SEND_LEASE_RECORD_TYPE);
    expect(await marks.highWaterMark(await vault.recordId(SEND_LEASE_RECORD_TYPE, 'op-1'))).toBe(
      undefined,
    );
    expect(await marks.highWaterMark(await vault.recordId('account', 'x'))).toBe(undefined);
    await tab.put({ type: 'account', naturalKey: 'x', plaintext: '{}' });
    expect(await marks.highWaterMark(await vault.recordId('account', 'x'))).toBe(1);
  });

  it('consults no mark: one already left for a lease row neither refuses it nor moves its revision', async () => {
    const { marks, reload, vault } = await opened();
    const id = await vault.recordId(SEND_LEASE_RECORD_TYPE, 'op-1');
    await marks.raiseTo(id, 5);
    const tab = reload();
    await renew(tab, 1_000);
    expect((await tab.get(SEND_LEASE_RECORD_TYPE, 'op-1'))?.revision).toBe(1);
    expect((await tab.list(SEND_LEASE_RECORD_TYPE)).map(({ revision }) => revision)).toEqual([1]);
    expect(await marks.highWaterMark(id)).toBe(5);
  });

  it("still seals a lease to its row: another row's ciphertext does not open", async () => {
    const { api, reload, vault } = await opened();
    const tab = reload();
    await renew(tab, 1_000);
    const id = await vault.recordId(SEND_LEASE_RECORD_TYPE, 'op-1');
    const row = await api.get(SEND_LEASE_RECORD_TYPE, id);
    if (row === null) throw new Error('the lease was not stored');
    const other = await vault.recordId(SEND_LEASE_RECORD_TYPE, 'op-2');
    api.setRaw(SEND_LEASE_RECORD_TYPE, other, row.ciphertext, row.revision);
    await expect(tab.get(SEND_LEASE_RECORD_TYPE, 'op-2')).rejects.toThrow();
  });

  it('survives a real heartbeat whose write fails when the send ends', async () => {
    const { api, reload } = await opened();
    const tab = reload();
    await claimed(tab);
    await renew(tab, 1_000);
    api.isOffline = true;
    const stop = keepSendLease(tab, 'op-1', () => 2_000);
    await stop();
    api.isOffline = false;
    expect(await listDrafts(reload())).toHaveLength(1);
  });
});

describe('a write that fails, on the real store', () => {
  const STALE = { name: 'VaultError', code: 'stale' };

  const CONTENT = {
    from: 'me@x.co',
    to: 'you@x.co',
    cc: '',
    bcc: '',
    subject: 'Hi',
    body: 'Hello',
  };

  /** One device: every store it opens is a tab or a reload over the same marks. */
  const device = async () => {
    const keys = await deriveAccountKeys({ email: 'user@example.com', password: 'password123456' });
    const { vault } = await createVault(keys);
    const api = new InMemoryVaultApi();
    const marks = inMemoryRevisionMarks();
    const open = () => createRecordStore({ vault, api, marks });
    return { api, marks, open, vault };
  };

  const savedDraft = async (store: ReturnType<typeof createRecordStore>) => {
    const created = await createDraft(store, CONTENT, 0);
    if (!created.ok) throw new Error('the fixture could not create a draft');
    return created.handle;
  };

  it('keeps a draft loading after an autosave whose PUT failed, and lets the retry land', async () => {
    const { api, open } = await device();
    const tab = open();
    const { draftId } = await savedDraft(tab);

    api.isOffline = true;
    expect(await replaceDraft(tab, draftId, { ...CONTENT, body: 'lost' }, 1)).toEqual({
      ok: false,
      reason: 'offline',
    });
    api.isOffline = false;

    expect((await listDrafts(tab))[0]?.record.body).toBe('Hello');
    expect((await listDrafts(open()))[0]?.record.body).toBe('Hello');
    const retried = await replaceDraft(tab, draftId, { ...CONTENT, body: 'kept' }, 2);
    expect(retried.ok).toBe(true);
    expect((await listDrafts(open()))[0]?.record.body).toBe('kept');
  });

  it("keeps a draft loading after a send's phase write failed, and lets the phase be written again", async () => {
    const { api, open } = await device();
    const tab = open();
    const { draftId } = await savedDraft(tab);
    const send = {
      messageId: '<m@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
    } as const;
    const claim = await claimSend(tab, draftId, send);
    if (!claim.ok) throw new Error('the fixture could not claim');

    api.isOffline = true;
    const submitted = { ...send, state: 'submitted' } as const;
    expect(await advanceSend(tab, claim.handle.draftId, submitted)).toBeNull();
    api.isOffline = false;

    expect((await listDrafts(open()))[0]?.record.send?.state).toBe('submitting');
    const advanced = await advanceSend(tab, claim.handle.draftId, submitted);
    expect(advanced?.record.send?.state).toBe('submitted');
  });

  it.each(['address', 'draft', 'draft-mirror', 'image-consents', 'image-sender', 'sent'])(
    'leaves a %s row readable, conditioned or not',
    async type => {
      const { api, open, vault } = await device();
      const tab = open();
      await tab.put({ type, naturalKey: 'k', plaintext: 'one' });
      const id = await vault.recordId(type, 'k');

      api.isOffline = true;
      await expect(tab.put({ type, naturalKey: 'k', plaintext: 'lost' })).rejects.toThrow();
      await expect(
        tab.put({
          type,
          naturalKey: 'k',
          plaintext: 'lost',
          precondition: { expect: 'revision', revision: 1 },
        }),
      ).rejects.toThrow();
      api.isOffline = false;

      expect(await tab.list(type)).toMatchObject([{ plaintext: 'one', revision: 1 }]);
      expect(await open().get(type, 'k')).toMatchObject({ plaintext: 'one', revision: 1 });
      expect(await api.get(type, id)).toMatchObject({ revision: 1 });
    },
  );

  it('reads a write that landed though its answer was lost, and then refuses what it replaced', async () => {
    const { api, marks, open, vault } = await device();
    const tab = open();
    await tab.put({ type: 'address', naturalKey: 'k', plaintext: 'one' });
    const id = await vault.recordId('address', 'k');
    const before = await api.get('address', id);
    if (before === null) throw new Error('the record was not stored');

    api.isAnswerLost = true;
    await expect(tab.put({ type: 'address', naturalKey: 'k', plaintext: 'two' })).rejects.toThrow();
    api.isAnswerLost = false;

    const opened = await open().get('address', 'k');
    expect(opened).toMatchObject({ plaintext: 'two', revision: 2 });
    expect(await marks.highWaterMark(id)).toBe(2);
    api.setRaw('address', id, before.ciphertext, before.revision);
    await expect(open().get('address', 'k')).rejects.toMatchObject(STALE);
  });

  it('answers a retry of its own lost write as a conflict naming that write, never a lockout', async () => {
    const { api, open } = await device();
    const tab = open();
    const { draftId, draftKey } = await savedDraft(tab);

    api.isAnswerLost = true;
    await replaceDraft(tab, draftId, { ...CONTENT, body: 'landed' }, 1);
    api.isAnswerLost = false;

    expect(await replaceDraft(tab, draftId, { ...CONTENT, body: 'again' }, 2)).toEqual({
      ok: false,
      reason: 'conflict',
      currentDraftId: `${draftKey}@2`,
    });
    expect((await listDrafts(tab))[0]?.record.body).toBe('landed');
  });

  it('leaves the mark alone for a tab that dies while its PUT is on the wire', async () => {
    const { api, marks, open, vault } = await device();
    const tab = open();
    await tab.put({ type: 'address', naturalKey: 'k', plaintext: 'one' });

    api.isHanging = true;
    void tab.put({ type: 'address', naturalKey: 'k', plaintext: 'never answered' });
    await vi.waitFor(() => expect(api.hungPuts).toBe(1));
    expect(await marks.highWaterMark(await vault.recordId('address', 'k'))).toBe(1);
    api.isHanging = false;

    expect(await open().get('address', 'k')).toMatchObject({ plaintext: 'one', revision: 1 });
  });

  it("lets two tabs share marks: one tab's failure stops neither, and its success binds both", async () => {
    const { api, open, vault } = await device();
    const [one, other] = [open(), open()];
    await one.put({ type: 'address', naturalKey: 'k', plaintext: 'first' });
    const id = await vault.recordId('address', 'k');
    const first = await api.get('address', id);
    if (first === null) throw new Error('the record was not stored');

    api.isOffline = true;
    await expect(
      one.put({ type: 'address', naturalKey: 'k', plaintext: 'lost' }),
    ).rejects.toThrow();
    api.isOffline = false;
    expect(await other.get('address', 'k')).toMatchObject({ plaintext: 'first' });

    await one.put({ type: 'address', naturalKey: 'k', plaintext: 'second' });
    api.setRaw('address', id, first.ciphertext, first.revision);
    await expect(other.get('address', 'k')).rejects.toMatchObject(STALE);
  });

  it('refuses a store that answered yes and kept the old row', async () => {
    const { api, open } = await device();
    const tab = open();
    await tab.put({ type: 'address', naturalKey: 'k', plaintext: 'old host' });

    api.isDroppingWrites = true;
    await tab.put({ type: 'address', naturalKey: 'k', plaintext: 'rotated host' });
    api.isDroppingWrites = false;

    await expect(open().get('address', 'k')).rejects.toMatchObject(STALE);
    await expect(open().list('address')).rejects.toMatchObject(STALE);
  });

  it('still refuses a replay of anything older than what it last saw, after a failed write', async () => {
    const { api, open, vault } = await device();
    const tab = open();
    await tab.put({ type: 'draft', naturalKey: 'k', plaintext: 'one' });
    const id = await vault.recordId('draft', 'k');
    const one = await api.get('draft', id);
    if (one === null) throw new Error('the record was not stored');
    await tab.put({
      type: 'draft',
      naturalKey: 'k',
      plaintext: 'two',
      precondition: { expect: 'revision', revision: 1 },
    });

    api.isOffline = true;
    await expect(
      tab.put({
        type: 'draft',
        naturalKey: 'k',
        plaintext: 'lost',
        precondition: { expect: 'revision', revision: 2 },
      }),
    ).rejects.toThrow();
    api.isOffline = false;

    api.setRaw('draft', id, one.ciphertext, one.revision);
    await expect(open().get('draft', 'k')).rejects.toMatchObject(STALE);
  });

  it('keeps refusing a row left behind a mark by an older build, until another device writes up to it', async () => {
    const { api, marks, open, vault } = await device();
    const tab = open();
    await tab.put({ type: 'draft', naturalKey: 'k', plaintext: 'one' });
    const id = await vault.recordId('draft', 'k');
    await marks.raiseTo(id, 2);
    await expect(open().list('draft')).rejects.toMatchObject(STALE);

    const elsewhere = createRecordStore({ vault, api, marks: inMemoryRevisionMarks() });
    await elsewhere.get('draft', 'k');
    await elsewhere.put({
      type: 'draft',
      naturalKey: 'k',
      plaintext: 'two',
      precondition: { expect: 'revision', revision: 1 },
    });

    expect(await open().list('draft')).toMatchObject([{ plaintext: 'two', revision: 2 }]);
  });
});
