import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRecordStore } from '../testing/fake-record-store.ts';
import type { RecordStore } from '../vault/record-store.ts';
import {
  DRAFT_RECORD_TYPE,
  type DraftRecord,
  openSendStateOf,
  parseDraftRecord,
  SEND_LEASE_CEILING_MS,
  SEND_LEASE_CLEANUP_MS,
  SEND_LEASE_MS,
  SEND_LEASE_RECORD_TYPE,
} from './draft-record.ts';
import {
  advanceSend,
  claimSend,
  createDraft,
  type DraftHandle,
  deleteDraft,
  listDrafts,
  reclaimSend,
  unconfirmSend,
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
  const claimed = await claimSend(store, created.handle.draftId, {
    messageId: '<out@x.co>',
    opId: 'op-1',
    state: 'submitting',
    claimedAt: 0,
    message: frozen,
    target: { account: 'me@x.co', folder: 'sent' },
  });
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
      copyToSent: async () => ({ ok: false, error: { kind: 'stalled' } }),
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

  describe('a Sent copy that fails', () => {
    const noFolder = {
      copyToSent: async () => ({ ok: false, error: { kind: 'no-sent-mailbox' } }),
    } satisfies Partial<SendEffects>;

    it('finishes the send when there is no Sent folder, as no retry could help', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store);
      const { effects, calls } = spyEffects(store, noFolder);

      expect(await driveSend(effects, handle)).toEqual({
        done: true,
        sentCopy: { ok: false, error: { kind: 'no-sent-mailbox' } },
      });
      expect(calls.expunge).toBe(1);
      const record = await readRecord(store, handle.draftKey);
      expect(record).toMatchObject({
        sentMessageId: '<out@x.co>',
        deletedAt: 1_000,
        isSentWithoutCopy: true,
      });
      expect(record?.send).toBeUndefined();
      expect(await listDrafts(store)).toEqual([]);
    });

    it('finishes one an unlock resumes the same way, without SMTP', async () => {
      const { store } = fakeRecordStore();
      const handle = await claim(store);
      await advanceSend(store, handle.draftId, {
        ...(handle.record.send as NonNullable<DraftRecord['send']>),
        state: 'submitted',
      });
      const { effects, calls } = spyEffects(store, { ...noFolder, now: () => SEND_LEASE_MS });

      await resumeSends(await listDrafts(store), () => effects);
      expect(calls.submit).toBe(0);
      expect(await listDrafts(store)).toEqual([]);
    });

    it.each([
      ['a stall', { kind: 'stalled' }],
      ['a closed connection', { kind: 'imap', reason: { kind: 'closed' } }],
      ['a refusal', { kind: 'imap', reason: { kind: 'no', text: 'Not allowed' } }],
      [
        'a full mailbox',
        { kind: 'imap', reason: { kind: 'no', text: '[OVERQUOTA] Mailbox full' } },
      ],
    ] as const)('keeps the send to settle on %s', async (_name, error) => {
      const { store } = fakeRecordStore();
      const handle = await claim(store);
      const { effects, calls } = spyEffects(store, {
        copyToSent: async () => ({ ok: false, error }),
      });

      expect(await driveSend(effects, handle)).toMatchObject({
        done: false,
        reason: 'copy-pending',
      });
      expect(calls.expunge).toBe(0);
      const [kept] = await listDrafts(store);
      expect(kept?.record.send?.state).toBe('submitted');
      expect(kept && openSendStateOf(kept.record, kept.renewedAt, SEND_LEASE_MS)).toBe('accepted');
    });
  });

  describe('the lease a running send keeps', () => {
    const MINUTE = 60_000;

    beforeEach(() => {
      vi.useFakeTimers({ now: 0 });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const stateOf = async (store: RecordStore) => {
      const [listed] = await listDrafts(store);
      if (listed === undefined) throw new Error('the draft should be listed');
      return openSendStateOf(listed.record, listed.renewedAt, Date.now());
    };

    /** A send whose SMTP attempt answers only when told. */
    const slowSend = async (store: RecordStore, over: Partial<SendEffects> = {}) => {
      const handle = await claim(store);
      const answer = Promise.withResolvers<Awaited<ReturnType<SendEffects['submit']>>>();
      const { effects, calls } = spyEffects(store, {
        submit: () => {
          calls.submit += 1;
          return answer.promise;
        },
        now: Date.now,
        ...over,
      });
      return { handle, answer, calls, driving: driveSend(effects, handle) };
    };

    it('cannot be taken over past 15 minutes of slow SMTP replies, so no device delivers twice', async () => {
      const { store } = fakeRecordStore();
      const { handle, answer, calls, driving } = await slowSend(store);

      for (const minute of [1, 4, 8, 15, 20]) {
        await vi.advanceTimersByTimeAsync(minute * MINUTE - Date.now());
        expect(await stateOf(store)).toBe('sending');
        expect(await reclaimSend(store, handle.draftId, Date.now())).toBeNull();
        expect(await unconfirmSend(store, handle.draftId, Date.now())).toBeNull();
        expect(await deleteDraft(store, handle.draftId, Date.now())).toEqual({
          outcome: 'sending',
        });
      }

      answer.resolve({ ok: true, value: undefined });
      expect(await driving).toMatchObject({ done: true });
      expect(calls.submit).toBe(1);
    });

    it('frees the draft about 3 minutes after the tab dies, and sends nothing on its own', async () => {
      const { store } = fakeRecordStore();
      let isDead = false;
      const dying: RecordStore = {
        ...store,
        // A dead tab's timers stop: nothing it would have written lands.
        put: async input => {
          if (isDead) throw new Error('the tab is gone');
          return store.put(input);
        },
      };
      const { calls } = await slowSend(dying);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      isDead = true;
      const diedAt = Date.now();

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(await stateOf(store)).toBe('sending');
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(await stateOf(store)).toBe('unconfirmed');
      expect(Date.now() - diedAt).toBeLessThanOrEqual(SEND_LEASE_MS + MINUTE);

      // Another device unlocking while it lapsed resumes nothing that might deliver twice.
      const unlock = spyEffects(store, { now: Date.now });
      await resumeSends(await listDrafts(store), () => unlock.effects);
      expect(unlock.calls).toEqual({ submit: 0, copy: 0, expunge: 0 });
      expect(calls.submit).toBe(1);
    });

    it('survives every other renewal being lost', async () => {
      const { store } = fakeRecordStore();
      let beat = 0;
      const flaky: RecordStore = {
        ...store,
        put: async input => {
          if (input.type === SEND_LEASE_RECORD_TYPE) {
            beat += 1;
            if (beat % 2 === 1) throw new Error('lost');
          }
          return store.put(input);
        },
      };
      await slowSend(flaky);
      for (const _minute of Array.from({ length: 20 })) {
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(await stateOf(store)).toBe('sending');
      }
    });

    it('keeps sending when every lease write fails', async () => {
      const { store } = fakeRecordStore();
      const down: RecordStore = {
        ...store,
        put: async input => {
          if (input.type === SEND_LEASE_RECORD_TYPE) throw new Error('down');
          return store.put(input);
        },
      };
      const { answer, driving } = await slowSend(down);
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      answer.resolve({ ok: true, value: undefined });
      expect(await driving).toMatchObject({ done: true });
    });

    /** A store whose lease writes never answer, and how many were started. */
    const hanging = (store: RecordStore) => {
      const count = { renewals: 0 };
      const hung: RecordStore = {
        ...store,
        put: input =>
          input.type === SEND_LEASE_RECORD_TYPE
            ? (() => {
                count.renewals += 1;
                return new Promise<void>(() => {});
              })()
            : store.put(input),
      };
      return { hung, count };
    };

    it('never writes the draft to stay held, and renews one write at a time', async () => {
      const { store, rows, key } = fakeRecordStore();
      const { hung, count } = hanging(store);
      const { handle } = await slowSend(hung);
      const row = rows.get(key(DRAFT_RECORD_TYPE, handle.draftKey));
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(rows.get(key(DRAFT_RECORD_TYPE, handle.draftKey))).toEqual(row);
      // One at a time, or an older write could land over a newer one.
      expect(count.renewals).toBe(1);
    });

    it('does not hold a finished send on a lease write that hangs', async () => {
      const { store } = fakeRecordStore();
      const { hung } = hanging(store);
      const { answer, driving } = await slowSend(hung);
      await vi.advanceTimersByTimeAsync(MINUTE);
      answer.resolve({ ok: true, value: undefined });
      let isSettled = false;
      void driving.then(() => {
        isSettled = true;
      });
      await vi.advanceTimersByTimeAsync(SEND_LEASE_CLEANUP_MS);
      expect(isSettled).toBe(true);
      expect(await driving).toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('does not hold a finished send on a remove that hangs', async () => {
      const { store } = fakeRecordStore();
      const hung: RecordStore = { ...store, remove: () => new Promise(() => {}) };
      const { answer, driving } = await slowSend(hung);
      await vi.advanceTimersByTimeAsync(MINUTE);
      answer.resolve({ ok: true, value: undefined });
      await vi.advanceTimersByTimeAsync(SEND_LEASE_CLEANUP_MS);
      expect(await driving).toMatchObject({ done: true });
    });

    it('stops an unlock stalling on one send whose lease write hangs', async () => {
      const { store } = fakeRecordStore();
      const { hung } = hanging(store);
      const first = await claim(store);
      const second = await claim(store);
      for (const { draftId, record } of [first, second]) {
        await advanceSend(store, draftId, {
          ...(record.send as NonNullable<DraftRecord['send']>),
          state: 'submitted',
        });
      }
      vi.setSystemTime(SEND_LEASE_MS);
      const slowCopy = Promise.withResolvers<void>();
      const { effects, calls } = spyEffects(hung, {
        now: Date.now,
        copyToSent: async () => {
          calls.copy += 1;
          if (calls.copy === 1) await slowCopy.promise;
          return { ok: true, value: null };
        },
      });
      const resuming = resumeSends(await listDrafts(store), () => effects);
      await vi.advanceTimersByTimeAsync(MINUTE);
      slowCopy.resolve();
      await vi.advanceTimersByTimeAsync(SEND_LEASE_CLEANUP_MS);
      await resuming;
      expect(calls.copy).toBe(2);
    });

    it('still removes the row first when it can, so a list after a failed copy sees no fresh lease', async () => {
      const { store, rows, key } = fakeRecordStore();
      const slowly: RecordStore = {
        ...store,
        remove: async (...args) => {
          await new Promise(resolve => setTimeout(resolve, 1_000));
          return store.remove(...args);
        },
      };
      const { handle, answer, driving } = await slowSend(slowly, {
        copyToSent: async () => ({ ok: false, error: { kind: 'stalled' } }),
      });
      const opId = handle.record.send?.opId ?? '';
      // Past the claim's own 3 minutes, so only the lease row could still say Sending.
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(rows.has(key(SEND_LEASE_RECORD_TYPE, opId))).toBe(true);
      const rowWhenItEnded = driving.then(() => rows.has(key(SEND_LEASE_RECORD_TYPE, opId)));
      answer.resolve({ ok: true, value: undefined });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await rowWhenItEnded).toBe(false);
      expect(await driving).toMatchObject({ reason: 'copy-pending' });
      expect(await stateOf(store)).toBe('accepted');
    });

    it('stops renewing at its ceiling without touching the attempt', async () => {
      const { store } = fakeRecordStore();
      const { answer, driving } = await slowSend(store);
      await vi.advanceTimersByTimeAsync(SEND_LEASE_CEILING_MS - MINUTE);
      expect(await stateOf(store)).toBe('sending');
      await vi.advanceTimersByTimeAsync(MINUTE + SEND_LEASE_MS);
      expect(await stateOf(store)).toBe('unconfirmed');
      expect(vi.getTimerCount()).toBe(0);
      // The attempt was never cut off: a late yes still lands.
      answer.resolve({ ok: true, value: undefined });
      expect(await driving).toMatchObject({ done: true });
    });

    it('writes no lease for a send over before the first beat', async () => {
      const { store } = fakeRecordStore();
      const put = vi.fn(store.put);
      const handle = await claim(store);
      const { effects } = spyEffects({ ...store, put }, { now: Date.now });
      await driveSend(effects, handle);
      expect(put.mock.calls.map(([{ type }]) => type)).not.toContain(SEND_LEASE_RECORD_TYPE);
    });

    const ENDINGS: readonly {
      readonly name: string;
      readonly over: Partial<SendEffects>;
      readonly outcome: 'resolves' | 'rejects';
    }[] = [
      {
        name: 'it finishes',
        over: { submit: async () => ({ ok: true, value: undefined }) },
        outcome: 'resolves',
      },
      {
        name: 'SMTP refuses it',
        over: { submit: async () => ({ ok: false, error: { kind: 'error', detail: 'no' } }) },
        outcome: 'resolves',
      },
      {
        name: "SMTP's answer is lost",
        over: {
          submit: async () => ({
            ok: false,
            error: { kind: 'smtp', reason: { kind: 'unconfirmed', detail: 'x' } },
          }),
        },
        outcome: 'resolves',
      },
      {
        name: 'the copy fails',
        over: {
          copyToSent: async () => ({ ok: false, error: { kind: 'stalled' } }),
        },
        outcome: 'resolves',
      },
      {
        name: 'there is no Sent folder',
        over: {
          copyToSent: async () => ({ ok: false, error: { kind: 'no-sent-mailbox' } }),
        },
        outcome: 'resolves',
      },
      {
        name: 'SMTP throws',
        over: {
          submit: async () => {
            throw new Error('boom');
          },
        },
        outcome: 'rejects',
      },
      {
        name: 'the copy throws',
        over: {
          copyToSent: async () => {
            throw new Error('boom');
          },
        },
        outcome: 'rejects',
      },
    ];

    it.each(ENDINGS)(
      'stops the heartbeat and removes its row when $name',
      async ({ over, outcome }) => {
        const { store, rows, key } = fakeRecordStore();
        const handle = await claim(store);
        const send = handle.record.send;
        if (send === undefined) throw new Error('the fixture claims');
        const started = Promise.withResolvers<void>();
        const { effects } = spyEffects(store, {
          now: Date.now,
          ...over,
          // Past a beat, so there is a row to remove.
          submit: async (...args) => {
            await started.promise;
            return (over.submit ?? (async () => ({ ok: true, value: undefined })))(...args);
          },
        });
        const driving = driveSend(effects, handle);
        const ended = expect(driving)[outcome].toBeDefined();
        await vi.advanceTimersByTimeAsync(MINUTE);
        expect(rows.has(key(SEND_LEASE_RECORD_TYPE, send.opId))).toBe(true);

        started.resolve();
        await ended;
        expect(vi.getTimerCount()).toBe(0);
        expect(rows.has(key(SEND_LEASE_RECORD_TYPE, send.opId))).toBe(false);
      },
    );

    it('stops the heartbeat when the record moved on without it', async () => {
      const { store } = fakeRecordStore();
      const { handle, answer, driving } = await slowSend(store);
      await reclaimSend(store, handle.draftId, SEND_LEASE_MS * 100);
      answer.resolve({ ok: true, value: undefined });
      expect(await driving).toEqual({ done: false, reason: 'unconfirmed' });
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('an unlock finishing what another left', () => {
    const accepted = async (store: RecordStore) => {
      const handle = await claim(store);
      const submitted = await advanceSend(store, handle.draftId, {
        ...(handle.record.send as NonNullable<DraftRecord['send']>),
        state: 'submitted',
      });
      if (submitted === null) throw new Error('the fixture could not advance');
      return submitted;
    };

    it('leaves a copy another device is still storing, however it reads', async () => {
      const { store } = fakeRecordStore();
      await accepted(store);
      const { effects, calls } = spyEffects(store, { now: () => SEND_LEASE_MS - 1 });
      await resumeSends(await listDrafts(store), () => effects);
      expect(calls.copy).toBe(0);
    });

    it('takes it over under a fresh claim once nobody runs it', async () => {
      const { store } = fakeRecordStore();
      const { draftKey } = await accepted(store);
      let during: DraftRecord | null = null;
      const { effects, calls } = spyEffects(store, {
        now: () => SEND_LEASE_MS,
        copyToSent: async () => {
          during = await readRecord(store, draftKey);
          return { ok: true, value: null };
        },
      });
      await resumeSends(await listDrafts(store), () => effects);
      expect(during).toMatchObject({ send: { state: 'submitted', claimedAt: SEND_LEASE_MS } });
      expect(calls.submit).toBe(0);
      expect(await listDrafts(store)).toEqual([]);
    });

    it('lets one of two devices unlocking together do it', async () => {
      const { store } = fakeRecordStore();
      await accepted(store);
      const listed = await listDrafts(store);
      const first = spyEffects(store, { now: () => SEND_LEASE_MS });
      const held = Promise.withResolvers<void>();
      const running = resumeSends(listed, () => ({
        ...first.effects,
        copyToSent: async () => {
          first.calls.copy += 1;
          await held.promise;
          return { ok: true, value: null };
        },
      }));
      await vi.waitFor(() => expect(first.calls.copy).toBe(1));
      const second = spyEffects(store, { now: () => SEND_LEASE_MS });
      await resumeSends(listed, () => second.effects);
      expect(second.calls.copy).toBe(0);
      held.resolve();
      await running;
    });
  });

  it('never sends a claim from a build that froze only `bytes`: its files would be missing', async () => {
    // What an older client's claim reads as here: the field it wrote is gone, the target is not.
    const { store } = fakeRecordStore();
    const created = await createDraft(store, content, 0);
    if (!created.ok) throw new Error('the fixture could not create a draft');
    const claimed = await claimSend(store, created.handle.draftId, {
      messageId: '<out@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
      target: 'vault',
    });
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
    const claimed = await claimSend(store, created.handle.draftId, {
      messageId: '<out@x.co>',
      opId: 'op-1',
      state: 'submitting',
      claimedAt: 0,
    });
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
