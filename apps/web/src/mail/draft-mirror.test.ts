import type { ImapClient, ImapMailbox } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import { draftMirrorMessageId, expungeMirror, mirrorAccountOf, mirrorDraft } from './draft-mirror';
import { createDraft, type DraftHandle, readMirror, writeMirror } from './draft-records';
import { stubImapClient } from './fake-imap-client';
import type { LiveClient, LiveTask } from './live';

const DRAFTS: ImapMailbox = {
  name: 'Drafts',
  delimiter: '/',
  attributes: ['\\Drafts'],
};

/** Records what the task asked the server to do, which is the whole subject of these tests. */
const server = (present: readonly number[] = [], over: Partial<ImapClient> = {}) => {
  const did: string[] = [];
  const client = stubImapClient({
    list: async () => ({ ok: true, value: [DRAFTS] }),
    // Which messages in the mailbox carry this draft's header — how the mirror finds every copy
    // of itself, including one a failed erase left behind.
    uidSearchHeader: async (header, value) => {
      did.push(`search ${header} ${value}`);
      return { ok: true, value: [...present] };
    },
    append: async mailbox => {
      did.push(`append ${mailbox}`);
      return { ok: true, value: { uidValidity: 1, uid: 77 } };
    },
    storeFlags: async (uidSet, mode, flags) => {
      did.push(`flag ${uidSet} ${mode} ${flags.join(',')}`);
      return { ok: true, value: undefined };
    },
    uidExpunge: async uidSet => {
      did.push(`expunge ${uidSet}`);
      return { ok: true, value: undefined };
    },
    ...over,
  });
  const run = <T>(task: LiveTask<T>) => task.run(client as LiveClient);
  return { did, run };
};

const draftFor = async (store: RecordStore): Promise<DraftHandle> => {
  const created = await createDraft(
    store,
    {
      from: 'me@x.co',
      to: 'you@x.co',
      cc: '',
      bcc: '',
      subject: 'Hi',
      body: 'Hello',
    },
    0,
  );
  if (!created.ok) throw new Error('the fixture could not create a draft');
  return created.handle;
};

const bytes = new Uint8Array([1, 2, 3]);

describe('the draft mirror', () => {
  it('appends the new copy before erasing the one it replaces', async () => {
    // The other order loses the draft outright if the connection drops between the two.
    const { store } = fakeRecordStore();
    const handle = await draftFor(store);
    await writeMirror(
      store,
      handle.draftKey,
      {
        mirroredVersion: 0,
        locator: { account: 'me@x.co', folder: 'Drafts', uidValidity: 1, uid: 12 },
      },
      { expect: 'absent' },
    );
    const { did, run } = server([12, 77]);

    await mirrorDraft(run, store, handle, bytes, 'me@x.co');
    expect(did).toEqual([
      'append Drafts',
      `search Message-ID ${draftMirrorMessageId(handle.draftKey, 'me@x.co')}`,
      'flag 12 add \\Deleted',
      'expunge 12',
    ]);
    expect((await readMirror(store, handle.draftKey))?.mirror).toEqual({
      mirroredVersion: 1,
      locator: { account: 'me@x.co', folder: 'Drafts', uidValidity: 1, uid: 77 },
    });
  });

  it('leaves the old copy alone when the mailbox has been renumbered', async () => {
    // Same uid, different message: erasing it would take somebody else's mail with it.
    const { store } = fakeRecordStore();
    const handle = await draftFor(store);
    await writeMirror(
      store,
      handle.draftKey,
      {
        mirroredVersion: 0,
        locator: { account: 'me@x.co', folder: 'Drafts', uidValidity: 9, uid: 12 },
      },
      { expect: 'absent' },
    );
    const { did, run } = server([77]);

    await mirrorDraft(run, store, handle, bytes, 'me@x.co');
    // Only the copy just appended is there, so there is nothing to erase.
    expect(did).toEqual([
      'append Drafts',
      `search Message-ID ${draftMirrorMessageId(handle.draftKey, 'me@x.co')}`,
    ]);
  });

  it('does nothing at all without UIDPLUS, rather than filling Drafts with every version', async () => {
    const { store } = fakeRecordStore();
    const handle = await draftFor(store);
    const { did, run } = server([], { hasCapability: () => false });

    await mirrorDraft(run, store, handle, bytes, 'me@x.co');
    expect(did).toEqual([]);
  });

  it('skips a version the copy already holds', async () => {
    const { store } = fakeRecordStore();
    const handle = await draftFor(store);
    await writeMirror(store, handle.draftKey, { mirroredVersion: 1 }, { expect: 'absent' });
    const { did, run } = server();

    await mirrorDraft(run, store, handle, bytes, 'me@x.co');
    expect(did).toEqual([]);
  });

  it('erases the copy when the draft is discarded', async () => {
    const { store } = fakeRecordStore();
    const handle = await draftFor(store);
    await writeMirror(
      store,
      handle.draftKey,
      {
        mirroredVersion: 1,
        locator: { account: 'me@x.co', folder: 'Drafts', uidValidity: 1, uid: 77 },
      },
      { expect: 'absent' },
    );
    const { did, run } = server([77]);

    await expungeMirror(run, store, handle.draftKey);
    expect(did).toEqual([
      `search Message-ID ${draftMirrorMessageId(handle.draftKey, 'me@x.co')}`,
      'flag 77 add \\Deleted',
      'expunge 77',
    ]);
    // The locator is gone: every copy of it is off the server.
    expect((await readMirror(store, handle.draftKey))?.mirror).toEqual({ mirroredVersion: 1 });
  });

  it('mirrors a send-only reply into the account that owns the thread', () => {
    const inbound = (address: string) => address === 'work@x.co';
    const base = { to: '', cc: '', bcc: '', subject: '', body: '', contentVersion: 1 };
    expect(mirrorAccountOf({ ...base, from: 'work@x.co' }, inbound)).toBe('work@x.co');
    expect(
      mirrorAccountOf({ ...base, from: 'alias@x.co', ownerAccount: 'work@x.co' }, inbound),
    ).toBe('work@x.co');
    // A new message from an address with no mailbox belongs nowhere, so it is mirrored nowhere.
    expect(mirrorAccountOf({ ...base, from: 'alias@x.co' }, inbound)).toBeNull();
  });
});

describe('draftMirrorMessageId', () => {
  it('is the same for every copy of one draft, which is what makes the sweep a sweep', () => {
    expect(draftMirrorMessageId('key-1', 'me@x.co')).toBe(draftMirrorMessageId('key-1', 'me@x.co'));
    expect(draftMirrorMessageId('key-1', 'me@x.co')).not.toBe(
      draftMirrorMessageId('key-2', 'me@x.co'),
    );
  });

  /**
   * The bug this replaced: a custom header is searchable only if the server chose to index it, and
   * Forward Email does not. `SEARCH HEADER X-Yozz-Draft <key>` answered an empty list for a message
   * carrying that exact header, `eraseOthers` read empty as "nothing to erase, done", and every
   * discard left its copy on the server. Message-ID is a header IMAP names, so it is indexed.
   */
  it('is a Message-ID, because a server need not index a header IMAP does not name', () => {
    expect(draftMirrorMessageId('key-1', 'me@x.co')).toMatch(/^<[^<>@]+@x\.co>$/);
  });
});
