import { describe, expect, it } from 'vitest';
import { fakeRecordStore } from '../testing/fake-record-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import { DRAFT_RECORD_TYPE, type DraftRecord, parseDraftRecord } from './draft-record.ts';
import { claimSend, createDraft, type DraftHandle, listDrafts } from './draft-vault.ts';
import { driveSend, resumeSends, type SendEffects } from './send-machine.ts';

const content = {
  from: 'me@x.co',
  to: 'you@x.co',
  cc: '',
  bcc: '',
  subject: 'Hi',
  body: 'Hello',
};

const bytes = new Uint8Array([1, 2, 3]);

const claim = async (store: RecordStore): Promise<DraftHandle> => {
  const created = await createDraft(store, content, 0);
  if (!created.ok) throw new Error('the fixture could not create a draft');
  const claimed = await claimSend(
    store,
    created.handle.draftId,
    {
      messageId: '<out@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
      bytes: bytes.toBase64(),
      target: { account: 'me@x.co', folder: 'sent' },
    },
    0,
  );
  if (!claimed.ok) throw new Error('the fixture could not claim the draft');
  return claimed.handle;
};

/** Counts every phase, so a test can say which steps ran and how many times. */
const spyEffects = (store: RecordStore, over: Partial<SendEffects> = {}) => {
  const calls = { submit: 0, copy: 0, expunge: 0 };
  const effects: SendEffects = {
    store,
    submit: async () => {
      calls.submit += 1;
      return { ok: true, value: undefined };
    },
    copyToSent: async () => {
      calls.copy += 1;
      return { ok: true, value: { account: 'me@x.co', folder: 'sent', uidValidity: 1, uid: 9 } };
    },
    expungeMirror: async () => {
      calls.expunge += 1;
    },
    now: () => 1_000,
    ...over,
  };
  return { effects, calls };
};

const readRecord = async (store: RecordStore, draftKey: string): Promise<DraftRecord | null> => {
  const row = await store.get(DRAFT_RECORD_TYPE, draftKey);
  return row === null ? null : parseDraftRecord(row.plaintext);
};

describe('the send state machine', () => {
  it('submits, copies, then leaves a tombstone that says what the draft became', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects, calls } = spyEffects(store);

    expect(await driveSend(effects, handle)).toMatchObject({ done: true });
    expect(calls).toEqual({ submit: 1, copy: 1, expunge: 1 });
    const record = await readRecord(store, handle.draftKey);
    expect(record?.sentMessageId).toBe('<out@x.co>');
    expect(record?.deletedAt).toBe(1_000);
    // Sent, so it is nobody's draft any more — including the next unlock's.
    expect(await listDrafts(store)).toEqual([]);
  });

  it('gives the draft back when SMTP refuses it, because nothing went out', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects, calls } = spyEffects(store, {
      submit: async () => ({ ok: false, error: { kind: 'error', detail: 'refused' } }),
    });

    expect(await driveSend(effects, handle)).toMatchObject({ done: false, reason: 'refused' });
    expect(calls.copy).toBe(0);
    const record = await readRecord(store, handle.draftKey);
    expect(record?.send).toBeUndefined();
    expect(record?.deletedAt).toBeUndefined();
  });

  it('gives the draft back when the server answers the end of the message with a refusal', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects } = spyEffects(store, {
      submit: async () => ({
        ok: false,
        error: { kind: 'smtp', reason: { kind: 'reply', code: 554, text: 'rejected' } },
      }),
    });

    expect(await driveSend(effects, handle)).toMatchObject({ done: false, reason: 'refused' });
    expect((await readRecord(store, handle.draftKey))?.send).toBeUndefined();
  });

  it('keeps the claim when the answer to the end of the message never came', async () => {
    // The server may be delivering it, so handing the draft back would invite a second copy.
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    let submits = 0;
    const { effects, calls } = spyEffects(store, {
      submit: async () => {
        submits += 1;
        return {
          ok: false,
          error: { kind: 'smtp', reason: { kind: 'unconfirmed', detail: 'connection closed' } },
        };
      },
    });

    expect(await driveSend(effects, handle)).toEqual({ done: false, reason: 'unconfirmed' });
    expect({ ...calls, submit: submits }).toEqual({ submit: 1, copy: 0, expunge: 0 });
    // Recorded at once, so no device reads it as a send still running.
    const record = await readRecord(store, handle.draftKey);
    expect(record?.send?.state).toBe('unconfirmed');
    expect(record?.deletedAt).toBeUndefined();
    // Nor does an unlock submit it again, or a second drive finish it: the person settles it.
    const listed = await listDrafts(store);
    await resumeSends(listed, () => effects);
    const [again] = listed;
    if (again === undefined) throw new Error('the unconfirmed draft should still be listed');
    expect(await driveSend(effects, again)).toEqual({ done: false, reason: 'unconfirmed' });
    expect({ ...calls, submit: submits }).toEqual({ submit: 1, copy: 0, expunge: 0 });
    expect((await readRecord(store, handle.draftKey))?.deletedAt).toBeUndefined();
  });

  it('keeps the draft frozen when only the Sent copy failed, and finishes it on the next run', async () => {
    // The message is already at the recipient, so a second SMTP submit would be a duplicate. The
    // resume must pick up at the copy, never at the submit.
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const failing = spyEffects(store, {
      copyToSent: async () => ({ ok: false, error: { kind: 'no-sent-mailbox' } }),
    });

    expect(await driveSend(failing.effects, handle)).toMatchObject({
      done: false,
      reason: 'copy-pending',
    });
    const midway = await readRecord(store, handle.draftKey);
    expect(midway?.send?.state).toBe('submitted');

    const [pending] = await listDrafts(store);
    if (pending === undefined) throw new Error('the frozen draft should still be listed');
    const retry = spyEffects(store);
    expect(await driveSend(retry.effects, pending)).toMatchObject({ done: true });
    expect(retry.calls).toEqual({ submit: 0, copy: 1, expunge: 1 });
  });

  it('never resends by itself: an unlock leaves `submitting` for the person to settle', async () => {
    const { store } = fakeRecordStore();
    await claim(store);
    const { effects, calls } = spyEffects(store);

    await resumeSends(await listDrafts(store), () => effects);
    expect(calls).toEqual({ submit: 0, copy: 0, expunge: 0 });
    const [still] = await listDrafts(store);
    expect(still?.record.send?.state).toBe('submitting');
  });

  it('frees a claim it cannot resume rather than freezing the draft for ever', async () => {
    // A claim from a build older than the machine: it excluded other devices but stored no bytes,
    // so there is nothing to submit and nothing to be careful about.
    const { store } = fakeRecordStore();
    const created = await createDraft(store, content, 0);
    if (!created.ok) return;
    const claimed = await claimSend(
      store,
      created.handle.draftId,
      { messageId: '<out@x.co>', opId: 'op-1', state: 'submitting', claimedAt: 0 },
      0,
    );
    if (!claimed.ok) return;
    const { effects, calls } = spyEffects(store);

    expect(await driveSend(effects, claimed.handle)).toMatchObject({
      done: false,
      reason: 'abandoned',
    });
    expect(calls.submit).toBe(0);
    expect((await readRecord(store, claimed.handle.draftKey))?.send).toBeUndefined();
  });
});
