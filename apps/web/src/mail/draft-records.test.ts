import { describe, expect, it } from 'vitest';
import {
  DRAFT_RECORD_TYPE,
  type DraftRecord,
  openSendStateOf,
  SEND_CLAIM_STALE_MS,
} from '../lib/drafts';
import { fakeRecordStore as fakeStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import {
  createDraft,
  deleteDraft,
  listDrafts,
  purgeExpiredDrafts,
  replaceDraft,
  reviveDraft,
} from './draft-records';

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

  it('lets any device take over a claim whose sending tab never came back', async () => {
    // Otherwise a tab that died mid-send freezes the draft on every device for ever: it can
    // neither be edited, discarded, nor sent again.
    const { store, rows, key } = fakeStore();
    const created = await createDraft(store, content(), 0);
    if (!created.ok) return;
    rows.set(key(DRAFT_RECORD_TYPE, created.handle.draftKey), {
      plaintext: JSON.stringify({
        ...created.handle.record,
        send: { messageId: '<out@x>', opId: 'op-1', state: 'submitting', claimedAt: 0 },
      } satisfies DraftRecord),
      revision: 2,
    });

    const stale = SEND_CLAIM_STALE_MS + 1;
    expect(
      await replaceDraft(store, created.handle.draftId, content({ body: 'edit' }), stale),
    ).toMatchObject({ ok: true });
  });

  it('reads a claim nobody is running any more as the question, not as sending', async () => {
    const base = content();
    const claimed: DraftRecord = {
      ...base,
      contentVersion: 1,
      send: { messageId: '<out@x>', opId: 'op-1', state: 'submitting', claimedAt: 0 },
    };
    // A tab killed at `submitting` leaves exactly this and never writes `unconfirmedSend`, so the
    // composer must reach 'unconfirmed' from `send` alone or its two buttons never render.
    expect(openSendStateOf(claimed, SEND_CLAIM_STALE_MS - 1)).toBe('sending');
    expect(openSendStateOf(claimed, SEND_CLAIM_STALE_MS + 1)).toBe('unconfirmed');
    const { send: _claim, ...rest } = claimed;
    expect(openSendStateOf({ ...rest, unconfirmedSend: _claim }, 0)).toBe('unconfirmed');
    expect(openSendStateOf({ ...base, contentVersion: 1 }, 0)).toBeNull();
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
