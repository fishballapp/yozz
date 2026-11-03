import { describe, expect, it, vi } from 'vitest';
import { fakeRecordStore as fakeStore } from '../testing/fake-record-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import {
  DRAFT_RECORD_TYPE,
  type DraftRecord,
  isFrozenBySend,
  openSendStateOf,
  parseDraftId,
  SEND_LEASE_MS,
  SEND_LEASE_RECORD_TYPE,
} from './draft-record.ts';
import {
  claimSend,
  completeSend,
  createDraft,
  deleteDraft,
  finishWithoutCopy,
  listDrafts,
  purgeExpiredDrafts,
  purgeSendLeases,
  readDraftHandle,
  readSendLease,
  reclaimSend,
  replaceDraft,
  reviveDraft,
  unconfirmSend,
} from './draft-vault.ts';

const content = (over: Partial<DraftRecord> = {}) => ({
  from: 'me@x.co',
  to: 'you@x.co',
  cc: '',
  bcc: '',
  subject: 'Hi',
  body: 'Hello',
  ...over,
});

describe('draft records', () => {
  it('creates at version 1 and replaces from the version it read', async () => {
    const { store } = fakeStore();
    const created = await createDraft(store, content(), 0);
    expect(created).toMatchObject({ ok: true, handle: { draftId: expect.stringMatching(/@1$/) } });
    if (!created.ok) return;

    const saved = await replaceDraft(
      store,
      created.handle.draftId,
      content({ body: 'Hello, you' }),
      0,
    );
    expect(saved).toMatchObject({ ok: true, handle: { draftId: expect.stringMatching(/@2$/) } });
  });

  it('keeps the conversation a reply belongs to across a save that does not name it', async () => {
    const { store } = fakeStore();
    const created = await createDraft(store, content({ threadId: 'mid/<parent@x.co>' }), 0);
    if (!created.ok) return;
    // The composer saves the editor's fields and nothing else, so a reply drafted by an agent
    // would lose its thread on the owner's first keystroke.
    const saved = await replaceDraft(store, created.handle.draftId, content({ body: 'edited' }), 0);
    expect(saved).toMatchObject({
      ok: true,
      handle: { record: { threadId: 'mid/<parent@x.co>' } },
    });
  });

  describe("a draft's files", () => {
    const receipt = { id: 'file-1', name: 'receipt.pdf', size: 3, kind: 'pdf' as const };

    it('keeps them across a save that does not state them', async () => {
      const { store } = fakeStore();
      const created = await createDraft(store, content({ attachments: [receipt] }), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      const saved = await replaceDraft(store, created.handle.draftId, content({ body: 'new' }), 0);
      expect(saved).toMatchObject({ ok: true, handle: { record: { attachments: [receipt] } } });
    });

    it('drops them when a save states an empty list', async () => {
      const { store } = fakeStore();
      const created = await createDraft(store, content({ attachments: [receipt] }), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      const saved = await replaceDraft(
        store,
        created.handle.draftId,
        content({ attachments: [] }),
        0,
      );
      expect(saved).toMatchObject({ ok: true, handle: { record: { attachments: [] } } });
    });

    it('holds on to them through a discard, for the 30 days it can be revived', async () => {
      const { store } = fakeStore();
      const created = await createDraft(store, content({ attachments: [receipt] }), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      const gone = await deleteDraft(store, created.handle.draftId, 1);
      if (gone.outcome !== 'deleted') throw new Error('the fixture could not discard');
      const revived = await reviveDraft(store, gone.draftId, 2);
      expect(revived).toMatchObject({ ok: true, handle: { record: { attachments: [receipt] } } });
    });

    it('lets go of them when a send completes', async () => {
      const { store } = fakeStore();
      const created = await createDraft(store, content({ attachments: [receipt] }), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      await completeSend(store, created.handle.draftId, '<m@x.co>', 1);
      const opened = await store.get(DRAFT_RECORD_TYPE, created.handle.draftKey);
      expect(JSON.parse(opened?.plaintext ?? '{}').attachments).toBeUndefined();
    });
  });

  it('keeps the conversation a reply belongs to across a claim that writes the newest text', async () => {
    const { store } = fakeStore();
    const created = await createDraft(store, content({ threadId: 'mid/<t@x.co>' }), 0);
    if (!created.ok) throw new Error('the fixture could not create a draft');
    const claimed = await claimSend(
      store,
      created.handle.draftId,
      { messageId: '<m@x.co>', opId: 'op', state: 'submitting', claimedAt: 0 },
      content({ body: 'newest' }),
    );
    expect(claimed).toMatchObject({
      ok: true,
      handle: { record: { body: 'newest', threadId: 'mid/<t@x.co>' } },
    });
  });

  it('refuses a save that names a version somebody else has moved past', async () => {
    const { store } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    const theirs = await replaceDraft(
      store,
      created.handle.draftId,
      content({ body: 'theirs' }),
      0,
    );
    expect(theirs.ok).toBe(true);

    // Ours still names version 1: refused, told what to re-read, and nothing is overwritten.
    const ours = await replaceDraft(store, created.handle.draftId, content({ body: 'ours' }), 0);
    expect(ours).toEqual({
      ok: false,
      reason: 'conflict',
      currentDraftId: `${created.handle.draftKey}@2`,
    });
    const [live] = await listDrafts(store);
    expect(live?.record.body).toBe('theirs');
  });

  it('freezes a draft while a send is in flight, on every device', async () => {
    const { store, rows, key } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    // What phase (0) of a send writes: from here the stored bytes ARE the message.
    const sending: DraftRecord = {
      ...created.handle.record,
      send: {
        messageId: '<out@x>',
        opId: 'op-1',
        state: 'submitting',
        claimedAt: 0,
      },
    };
    rows.set(key(DRAFT_RECORD_TYPE, created.handle.draftKey), {
      plaintext: JSON.stringify(sending),
      revision: 2,
    });

    expect(await replaceDraft(store, created.handle.draftId, content({ body: 'edit' }), 0)).toEqual(
      {
        ok: false,
        reason: 'sending',
      },
    );
    expect(await deleteDraft(store, created.handle.draftId, 0)).toEqual({ outcome: 'sending' });
  });

  describe('how long a claim holds', () => {
    const MINUTE = 60_000;
    const claimOf = (state: NonNullable<DraftRecord['send']>['state']) =>
      ({
        messageId: '<out@x>',
        opId: 'op-1',
        state,
        claimedAt: 0,
      }) as const;
    const claimedAs = async (
      state: NonNullable<DraftRecord['send']>['state'],
      extra: Partial<DraftRecord> = {},
    ) => {
      const { store, rows, key } = fakeStore();
      const created = await createDraft(store, content(), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      const record: DraftRecord = { ...created.handle.record, ...extra, send: claimOf(state) };
      rows.set(key(DRAFT_RECORD_TYPE, created.handle.draftKey), {
        plaintext: JSON.stringify(record),
        revision: 2,
      });
      const renewAt = (renewedAt: number) =>
        store.put({
          type: SEND_LEASE_RECORD_TYPE,
          naturalKey: 'op-1',
          plaintext: JSON.stringify({ renewedAt }),
        });
      return { store, rows, key, record, renewAt, draftId: created.handle.draftId };
    };

    it('holds a claim with no lease for 3 minutes from when it was taken', async () => {
      const { record } = await claimedAs('submitting');
      expect(openSendStateOf(record, undefined, SEND_LEASE_MS - 1)).toBe('sending');
      expect(openSendStateOf(record, undefined, SEND_LEASE_MS)).toBe('unconfirmed');
    });

    it('lets nobody take over a send past 15 minutes while its lease is renewed', async () => {
      const { store, draftId, renewAt } = await claimedAs('submitting');
      await renewAt(20 * MINUTE);
      const at = 22 * MINUTE;
      expect(await reclaimSend(store, draftId, at)).toBeNull();
      expect(await unconfirmSend(store, draftId, at)).toBeNull();
      expect(await deleteDraft(store, draftId, at)).toEqual({ outcome: 'sending' });
      const [listed] = await listDrafts(store);
      if (listed === undefined) throw new Error('the draft should be listed');
      expect(openSendStateOf(listed.record, listed.renewedAt, at)).toBe('sending');
    });

    it('frees it 3 minutes after the last renewal', async () => {
      const { store, draftId, renewAt } = await claimedAs('submitting');
      await renewAt(20 * MINUTE);
      const reclaimed = await reclaimSend(store, draftId, 20 * MINUTE + SEND_LEASE_MS);
      expect(reclaimed?.record.send?.claimedAt).toBe(20 * MINUTE + SEND_LEASE_MS);
    });

    it('reads a claim nobody runs as the question, however it got there', async () => {
      const { record } = await claimedAs('submitting');
      const { send: _claim, ...rest } = record;
      // A tab killed at `submitting` never writes `unconfirmedSend`, so the composer must reach
      // the question from `send` alone or its two buttons never render.
      expect(openSendStateOf({ ...rest, unconfirmedSend: _claim }, undefined, 0)).toBe(
        'unconfirmed',
      );
      expect(openSendStateOf(rest, undefined, 0)).toBeNull();
    });

    it('keeps an expired `submitting` frozen, so only the person settles it', async () => {
      const { store, draftId, record } = await claimedAs('submitting');
      const late = SEND_LEASE_MS + 1;
      expect(await replaceDraft(store, draftId, content({ body: 'edit' }), late)).toEqual({
        ok: false,
        reason: 'sending',
      });
      expect(await claimSend(store, draftId, claimOf('submitting'))).toEqual({
        ok: false,
        reason: 'sending',
      });
      expect(isFrozenBySend(record)).toBe(true);
    });

    it('lets the person drop an expired `submitting`, which may never have reached SMTP', async () => {
      const { store, draftId } = await claimedAs('submitting');
      expect(await deleteDraft(store, draftId, SEND_LEASE_MS)).toMatchObject({
        outcome: 'deleted',
      });
    });

    it.each(['submitted', 'copied'] as const)(
      'never unfreezes a `%s` send, which SMTP accepted: nothing can deliver it again',
      async state => {
        const { store, draftId, record } = await claimedAs(state);
        const late = SEND_LEASE_MS * 100;
        expect(openSendStateOf(record, undefined, late)).toBe('accepted');
        expect(isFrozenBySend(record)).toBe(true);
        expect(await replaceDraft(store, draftId, content({ body: 'edit' }), late)).toEqual({
          ok: false,
          reason: 'sending',
        });
        expect(await claimSend(store, draftId, claimOf('submitting'))).toEqual({
          ok: false,
          reason: 'sending',
        });
        expect(await deleteDraft(store, draftId, late)).toEqual({ outcome: 'sending' });
        // Back to editing would make the next Send a second delivery.
        expect(await unconfirmSend(store, draftId, late)).toBeNull();
      },
    );

    it('takes over an accepted send at its phase, never back at `submitting`', async () => {
      const { store, draftId } = await claimedAs('submitted');
      const taken = await reclaimSend(store, draftId, SEND_LEASE_MS);
      expect(taken?.record.send).toMatchObject({ state: 'submitted', claimedAt: SEND_LEASE_MS });
    });

    it('takes an expired `submitting` back under a fresh claim, and only once', async () => {
      const { store, draftId } = await claimedAs('submitting');
      const taken = await reclaimSend(store, draftId, SEND_LEASE_MS);
      expect(taken?.record.send).toMatchObject({ state: 'submitting', claimedAt: SEND_LEASE_MS });
      // The second click or device names the version the first moved on from.
      expect(await reclaimSend(store, draftId, SEND_LEASE_MS)).toBeNull();
      if (taken === null) throw new Error('the takeover wrote nothing');
      expect(await reclaimSend(store, taken.draftId, SEND_LEASE_MS)).toBeNull();
    });

    it('does not let the lease of a claim taken over hold the new one', async () => {
      const { store, draftId, renewAt } = await claimedAs('submitting');
      const taken = await reclaimSend(store, draftId, SEND_LEASE_MS);
      if (taken === null) throw new Error('the takeover wrote nothing');
      // The tab it was taken from is alive after all, and still renewing its own.
      await renewAt(100 * MINUTE);
      expect(await readSendLease(store, taken.record)).toBeUndefined();
      expect(await reclaimSend(store, taken.draftId, SEND_LEASE_MS * 2)).not.toBeNull();
    });

    describe('finishing a send whose copy can never land', () => {
      const attachments = [{ id: 'f', name: 'a.zip', size: 1, kind: 'archive' }] as const;

      it('tombstones what went out, saying what it became and freeing its files', async () => {
        const { store, draftId } = await claimedAs('submitted', {
          attachments: [...attachments],
        });
        const done = await finishWithoutCopy(store, draftId, SEND_LEASE_MS);
        expect(done?.record).toMatchObject({
          sentMessageId: '<out@x>',
          deletedAt: SEND_LEASE_MS,
          isSentWithoutCopy: true,
        });
        expect(done?.record.attachments).toBeUndefined();
        expect(done?.record.send).toBeUndefined();
        expect(await listDrafts(store)).toEqual([]);
      });

      it('refuses while the copy is still being tried', async () => {
        const { store, draftId } = await claimedAs('submitted');
        expect(await finishWithoutCopy(store, draftId, SEND_LEASE_MS - 1)).toBeNull();
      });

      it('refuses a send nobody saw the answer to, which may not have gone out', async () => {
        const { store, draftId } = await claimedAs('submitting');
        expect(await finishWithoutCopy(store, draftId, SEND_LEASE_MS)).toBeNull();
      });
    });

    it('lists a held draft with its lease, and asks for leases only when one has a send', async () => {
      const { store, renewAt } = await claimedAs('submitting');
      await renewAt(MINUTE);
      const [held] = await listDrafts(store);
      expect(held?.renewedAt).toBe(MINUTE);

      const plain = fakeStore().store;
      await createDraft(plain, content(), 0);
      const list = vi.fn(plain.list);
      await listDrafts({ ...plain, list });
      expect(list.mock.calls).toEqual([[DRAFT_RECORD_TYPE]]);
    });

    it('reads one draft as it stands, and `null` once it is gone', async () => {
      const { store, draftId, renewAt } = await claimedAs('submitting');
      await renewAt(MINUTE);
      const draftKey = parseDraftId(draftId)?.key ?? '';
      expect(await readDraftHandle(store, draftKey)).toMatchObject({ renewedAt: MINUTE });
      await deleteDraft(store, draftId, SEND_LEASE_MS + MINUTE);
      expect(await readDraftHandle(store, draftKey)).toBeNull();
    });

    it('sweeps the lease rows dead tabs left, and leaves a live one', async () => {
      const { store } = fakeStore();
      const row = (naturalKey: string, renewedAt: number) =>
        store.put({
          type: SEND_LEASE_RECORD_TYPE,
          naturalKey,
          plaintext: JSON.stringify({ renewedAt }),
        });
      await row('dead', 0);
      await row('live', MINUTE);
      await purgeSendLeases(store, SEND_LEASE_MS + 1);
      const left = await store.list(SEND_LEASE_RECORD_TYPE);
      expect(left.map(({ naturalKey }) => naturalKey)).toEqual(['live']);
    });
  });

  describe('a send whose answer was lost', () => {
    const lost = {
      messageId: '<out@x>',
      opId: 'op-1',
      state: 'unconfirmed',
      claimedAt: 0,
    } as const;
    const seeded = async () => {
      const { store, rows, key } = fakeStore();
      const created = await createDraft(store, content(), 0);
      if (!created.ok) throw new Error('the fixture could not create a draft');
      rows.set(key(DRAFT_RECORD_TYPE, created.handle.draftKey), {
        plaintext: JSON.stringify({ ...created.handle.record, send: lost } satisfies DraftRecord),
        revision: 2,
      });
      const [handle] = await listDrafts(store);
      if (handle === undefined) throw new Error('the fixture lost its draft');
      return { store, handle };
    };

    it('is the question at once, not a send still running', async () => {
      const { handle } = await seeded();
      expect(openSendStateOf(handle.record, undefined, 0)).toBe('unconfirmed');
    });

    it('refuses edits, a new send and discard, however old, until the person settles it', async () => {
      const { store, handle } = await seeded();
      const late = SEND_LEASE_MS + 1;
      expect(await replaceDraft(store, handle.draftId, content({ body: 'edit' }), late)).toEqual({
        ok: false,
        reason: 'sending',
      });
      expect(await claimSend(store, handle.draftId, { ...lost, state: 'submitting' })).toEqual({
        ok: false,
        reason: 'sending',
      });
      expect(await deleteDraft(store, handle.draftId, late)).toEqual({ outcome: 'sending' });
    });

    it('goes back under a fresh claim on Send again, the same message', async () => {
      const { store, handle } = await seeded();
      const reclaimed = await reclaimSend(store, handle.draftId, 7_000);
      expect(reclaimed?.record.send).toEqual({
        ...lost,
        state: 'submitting',
        claimedAt: 7_000,
        opId: expect.not.stringMatching(/^op-1$/u),
      });
    });

    it('is put aside on Back to editing, editable, and still not discardable', async () => {
      const { store, handle } = await seeded();
      const aside = await unconfirmSend(store, handle.draftId, 0);
      if (aside === null) throw new Error('Back to editing wrote nothing');
      expect(aside.record.send).toBeUndefined();
      expect(aside.record.unconfirmedSend).toEqual(lost);
      expect(await deleteDraft(store, aside.draftId, 0)).toEqual({ outcome: 'sending' });
      const edited = await replaceDraft(store, aside.draftId, content({ body: 'edit' }), 0);
      if (!edited.ok) throw new Error('an edit after Back to editing was refused');
      // And Send again from there re-stamps it too.
      const reclaimed = await reclaimSend(store, edited.handle.draftId, 9_000);
      expect(reclaimed?.record.send).toMatchObject({ state: 'submitting', claimedAt: 9_000 });
      expect(reclaimed?.record.unconfirmedSend).toBeUndefined();
    });
  });

  it('soft-deletes, hides it, and revives it by name', async () => {
    const { store } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;

    const deleted = await deleteDraft(store, created.handle.draftId, 1_000);
    expect(deleted).toMatchObject({ outcome: 'deleted' });
    if (deleted.outcome !== 'deleted') return;
    expect(await listDrafts(store)).toEqual([]);
    // Deleting a tombstone finds nothing: it is gone, not a second thing to delete.
    expect(await deleteDraft(store, deleted.draftId, 2_000)).toEqual({ outcome: 'absent' });

    expect(await reviveDraft(store, deleted.draftId, 0)).toMatchObject({ ok: true });
    const [live] = await listDrafts(store);
    expect(live?.record.body).toBe('Hello');
    expect(live?.record.deletedAt).toBeUndefined();
  });

  it('tombstones from the version a conflict names, which is how a send tidies up', async () => {
    // Sending does not wait for the autosave, so the id in hand is often one behind. The refusal
    // has to be usable, or a sent draft stays alive and can be sent a second time.
    const { store } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    await replaceDraft(store, created.handle.draftId, content({ body: 'newer' }), 0);

    const stale = await deleteDraft(store, created.handle.draftId, 1_000);
    expect(stale).toMatchObject({ outcome: 'conflict' });
    if (stale.outcome !== 'conflict') return;
    expect(await deleteDraft(store, stale.currentDraftId, 1_000)).toMatchObject({
      outcome: 'deleted',
    });
    expect(await listDrafts(store)).toEqual([]);
  });

  it('names the version that WON when the race is lost mid-write', async () => {
    // The dangerous shape: our read said version 1, and the other device wrote between that read
    // and our PUT. Reporting our own stale id would leave the caller unable to find the winner,
    // so no conflict banner appears and the newest text lives only in the editor.
    const { store, rows, key } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    const id = key(DRAFT_RECORD_TYPE, created.handle.draftKey);

    const realPut = store.put;
    let raced = false;
    const racing: RecordStore = {
      ...store,
      put: async input => {
        if (!raced && input.type === DRAFT_RECORD_TYPE) {
          raced = true;
          const theirs = { ...created.handle.record, contentVersion: 2, body: 'theirs' };
          rows.set(id, { plaintext: JSON.stringify(theirs), revision: 2 });
        }
        await realPut(input);
      },
    };

    const ours = await replaceDraft(racing, created.handle.draftId, content({ body: 'ours' }), 0);
    expect(ours).toEqual({
      ok: false,
      reason: 'conflict',
      currentDraftId: `${created.handle.draftKey}@2`,
    });
  });

  it('purges a tombstone past its window and leaves a fresh one alone', async () => {
    const { store } = fakeStore();
    const old = await createDraft(store, content({ body: 'old' }), 0);
    const recent = await createDraft(store, content({ body: 'recent' }), 0);
    if (!old.ok || !recent.ok) return;
    const day = 24 * 60 * 60 * 1000;
    await deleteDraft(store, old.handle.draftId, 0);
    await deleteDraft(store, recent.handle.draftId, 29 * day);

    expect(await purgeExpiredDrafts(store, 31 * day)).toBe(1);
    // The recent one is still revivable, which is the whole point of the window.
    expect(await reviveDraft(store, `${recent.handle.draftKey}@2`, 31 * day)).toMatchObject({
      ok: true,
    });
    expect((await listDrafts(store)).map(d => d.record.body)).toEqual(['recent']);
  });

  it('refuses a create that would land on a key already in use', async () => {
    // The key is random, so this is the paranoid case — and the one where being wrong means
    // taking over somebody else's draft.
    const { store, rows, key } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    await expect(
      store.put({
        type: DRAFT_RECORD_TYPE,
        naturalKey: created.handle.draftKey,
        plaintext: '{}',
        precondition: { expect: 'absent' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(rows.get(key(DRAFT_RECORD_TYPE, created.handle.draftKey))?.plaintext).toContain('Hello');
  });
});
