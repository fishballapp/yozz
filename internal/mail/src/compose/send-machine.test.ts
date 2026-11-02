import { describe, expect, it } from 'vitest';
import { fakeRecordStore } from '../testing/fake-record-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import { DRAFT_RECORD_TYPE, type DraftRecord, parseDraftRecord } from './draft-record.ts';
import {
  advanceSend,
  claimSend,
  createDraft,
  type DraftHandle,
  listDrafts,
  reclaimSend,
} from './draft-vault.ts';
import { driveSend, resumeSends, type SendEffects } from './send-machine.ts';

const content = {
  from: 'me@x.co',
  to: 'you@x.co',
  cc: '',
  bcc: '',
  subject: 'Hi',
  body: 'Hello',
};

const head = new TextEncoder().encode('HEAD|TAIL');
const FILE_ID = 'file-1';
const message = (splices: readonly { at: number; fileId: string }[] = []) => ({
  head: head.toBase64(),
  splices: [...splices],
});
const attachment = {
  id: FILE_ID,
  name: 'receipt.pdf',
  size: 3,
  kind: 'pdf',
} as const;

const claim = async (
  store: RecordStore,
  frozen = message(),
  extra: { attachments?: (typeof attachment)[] } = {},
): Promise<DraftHandle> => {
  const created = await createDraft(store, { ...content, ...extra }, 0);
  if (!created.ok) throw new Error('the fixture could not create a draft');
  const claimed = await claimSend(
    store,
    created.handle.draftId,
    {
      messageId: '<out@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
      message: frozen,
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
    readFile: async () => null,
    submit: async () => {
      calls.submit += 1;
      return { ok: true, value: undefined };
    },
    copyToSent: async (_target, { assemble }) => {
      calls.copy += 1;
      const assembled = await assemble();
      if (!assembled.ok) return assembled;
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

  it('renews the claim once SMTP has accepted, so the Sent copy has a lifetime of its own', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    let during: DraftRecord | null = null;
    const { effects } = spyEffects(store, {
      copyToSent: async () => {
        during = await readRecord(store, handle.draftKey);
        return { ok: true, value: null };
      },
    });

    await driveSend(effects, handle);
    expect(during).toMatchObject({ send: { state: 'submitted', claimedAt: 1_000 } });
  });

  it('gives the draft back when SMTP refuses it, because nothing went out', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects, calls } = spyEffects(store, {
      submit: async () => ({ ok: false, error: { kind: 'error', detail: 'refused' } }),
    });

    expect(await driveSend(effects, handle)).toMatchObject({
      done: false,
      reason: 'refused',
      isFileUnreadable: false,
    });
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

  it('gives the draft back when the host refuses the message for its size, as nothing went out', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects } = spyEffects(store, {
      submit: async () => ({
        ok: false,
        error: { kind: 'smtp', reason: { kind: 'too-large', limitBytes: 35_882_577 } },
      }),
    });

    expect(await driveSend(effects, handle)).toMatchObject({ done: false, reason: 'refused' });
    const record = await readRecord(store, handle.draftKey);
    expect(record?.send).toBeUndefined();
    expect(record?.deletedAt).toBeUndefined();
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

  describe('a message whose files are in R2', () => {
    const splice = [{ at: 'HEAD|'.length, fileId: FILE_ID }];
    const file = new Uint8Array([1, 2, 3]);
    const expected = new TextEncoder().encode('HEAD|AQIDTAIL');

    it('submits and copies the head with the file spliced in, reading it once', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice));
      const reads: string[] = [];
      const seen: { submitted?: Uint8Array; copied?: Uint8Array } = {};
      const { effects, calls } = spyEffects(store, {
        readFile: async fileId => {
          reads.push(fileId);
          return file;
        },
        submit: async bytes => {
          seen.submitted = bytes;
          return { ok: true, value: undefined };
        },
        copyToSent: async (_target, { assemble }) => {
          const assembled = await assemble();
          if (assembled.ok) seen.copied = assembled.value;
          return { ok: true, value: null };
        },
      });

      expect(await driveSend(effects, handle)).toMatchObject({ done: true });
      expect(seen.submitted).toEqual(expected);
      expect(seen.copied).toEqual(expected);
      expect(reads).toEqual([FILE_ID]);
      expect(calls.expunge).toBe(1);
    });

    it('gives the draft back, submitting nothing, when a file cannot be read before SMTP', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice), { attachments: [attachment] });
      const { effects, calls } = spyEffects(store, { readFile: async () => null });

      const progress = await driveSend(effects, handle);

      expect(progress).toMatchObject({
        done: false,
        reason: 'refused',
        error: {
          kind: 'error',
          detail: 'Couldn’t download receipt.pdf',
        },
        isFileUnreadable: true,
      });
      expect(calls).toEqual({ submit: 0, copy: 0, expunge: 0 });
      const record = await readRecord(store, handle.draftKey);
      expect(record?.send).toBeUndefined();
      expect(record?.deletedAt).toBeUndefined();
      expect(record?.attachments).toEqual([attachment]);
    });

    it('treats a read that throws as unreadable, and says so before SMTP', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice));
      const { effects, calls } = spyEffects(store, {
        readFile: async () => {
          throw new Error('offline');
        },
      });

      expect(await driveSend(effects, handle)).toMatchObject({ done: false, reason: 'refused' });
      expect(calls.submit).toBe(0);
      expect((await readRecord(store, handle.draftKey))?.send).toBeUndefined();
    });

    it('holds a sent message as copy-pending when a file cannot be read for its copy', async () => {
      // Submitted on one device, resumed on another that cannot reach R2: it is already out, so the
      // claim stays and nothing is sent again.
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice), { attachments: [attachment] });
      const submitted = await advanceSend(store, handle.draftId, {
        ...(handle.record.send as NonNullable<DraftRecord['send']>),
        state: 'submitted',
      });
      if (submitted === null) throw new Error('the fixture could not advance');
      const { effects, calls } = spyEffects(store, { readFile: async () => null });

      expect(await driveSend(effects, submitted)).toMatchObject({
        done: false,
        reason: 'copy-pending',
        error: {
          kind: 'error',
          detail: 'Couldn’t download receipt.pdf',
        },
      });
      expect(calls.submit).toBe(0);
      const record = await readRecord(store, handle.draftKey);
      expect(record?.send?.state).toBe('submitted');
      expect(record?.attachments).toEqual([attachment]);
    });

    it('sends the same bytes again after a crash, however the file was read', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice));
      const seen: Uint8Array[] = [];
      const submit: SendEffects['submit'] = async bytes => {
        seen.push(bytes);
        return { ok: false, error: { kind: 'smtp', reason: { kind: 'unconfirmed', detail: 'x' } } };
      };
      await driveSend(spyEffects(store, { readFile: async () => file, submit }).effects, handle);
      const again = await reclaimSend(store, `${handle.draftKey}@3`, 2_000);
      if (again === null) throw new Error('the fixture could not reclaim');
      await driveSend(spyEffects(store, { readFile: async () => file, submit }).effects, again);

      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(seen[1]);
    });

    it('stops naming its files once sent, and only then', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice), { attachments: [attachment] });
      const { effects } = spyEffects(store, {
        readFile: async () => file,
        copyToSent: async () => {
          // The copy is the last moment the files are still needed.
          expect((await readRecord(store, handle.draftKey))?.attachments).toEqual([attachment]);
          return { ok: true, value: null };
        },
      });

      expect(await driveSend(effects, handle)).toMatchObject({ done: true });
      const record = await readRecord(store, handle.draftKey);
      expect(record?.attachments).toBeUndefined();
      expect(record?.deletedAt).toBe(1_000);
    });

    it('leaves a vault copy free to finish without the files', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store, message(splice));
      const reads: string[] = [];
      const submitted = await advanceSend(store, handle.draftId, {
        ...(handle.record.send as NonNullable<DraftRecord['send']>),
        state: 'submitted',
        target: 'vault',
      });
      if (submitted === null) throw new Error('the fixture could not advance');
      const { effects } = spyEffects(store, {
        readFile: async fileId => {
          reads.push(fileId);
          return null;
        },
        copyToSent: async () => ({ ok: true, value: null }),
      });

      expect(await driveSend(effects, submitted)).toMatchObject({ done: true });
      expect(reads).toEqual([]);
    });
  });

  it('writes each phase down before the step it names', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const phases: (string | undefined)[] = [];
    const phase = async () => (await readRecord(store, handle.draftKey))?.send?.state;
    const { effects } = spyEffects(store, {
      submit: async () => {
        phases.push(await phase());
        return { ok: true, value: undefined };
      },
      copyToSent: async () => {
        phases.push(await phase());
        return { ok: true, value: null };
      },
      expungeMirror: async () => {
        phases.push(await phase());
        expect((await readRecord(store, handle.draftKey))?.deletedAt).toBe(1_000);
      },
    });

    expect(await driveSend(effects, handle)).toMatchObject({ done: true });
    expect(phases).toEqual(['submitting', 'submitted', undefined]);
  });

  it('asks rather than guesses when SMTP took it but the record could not say so', async () => {
    const { store } = fakeRecordStore();
    const handle = await claim(store);
    const { effects, calls } = spyEffects(store, {
      // Another device moved the record on between the claim and SMTP's yes.
      submit: async () => {
        await advanceSend(store, handle.draftId, {
          ...(handle.record.send as NonNullable<DraftRecord['send']>),
          opId: 'someone-else',
        });
        return { ok: true, value: undefined };
      },
    });

    expect(await driveSend(effects, handle)).toEqual({ done: false, reason: 'unconfirmed' });
    expect(calls.copy).toBe(0);
    expect((await readRecord(store, handle.draftKey))?.deletedAt).toBeUndefined();
  });

  it('never sends a claim from a build that froze only `bytes`: its files would be missing', async () => {
    // What an older client's claim reads as here: the field it wrote is gone, the target is not.
    const { store } = fakeRecordStore();
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
        target: 'vault',
      },
      0,
    );
    if (!claimed.ok) throw new Error('the fixture could not claim the draft');
    const { effects, calls } = spyEffects(store);

    expect(await driveSend(effects, claimed.handle)).toEqual({ done: false, reason: 'abandoned' });
    expect(calls.submit).toBe(0);
    expect((await readRecord(store, claimed.handle.draftKey))?.send).toBeUndefined();
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
