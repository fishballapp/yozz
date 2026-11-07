// @vitest-environment jsdom

import type { ImapMessageSummary } from '@yozz.app/imap';
import { ADDRESS_RECORD_TYPE, type InboundAddress } from '@yozz.app/mail/addresses/record';
import { fakeFileStore } from '@yozz.app/mail/testing/fake-file-store';
import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import { memoryMailCache } from '@yozz.app/mail/testing/memory-mail-cache';
import type { MailCache } from '@yozz.app/mail/threads/cache';
import {
  CACHE_SNAPSHOT_RECORD_TYPE,
  createSnapshotWriter,
} from '@yozz.app/mail/threads/cache-snapshot';
import type { FileStore } from '@yozz.app/mail/vault/file-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  session: null as { userId: string; files: FileStore; store: RecordStore } | null,
  /** This device's cache, by address. */
  caches: new Map<string, MailCache>(),
  syncMailbox: vi.fn(),
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({
    run: async () => ({ ok: false, error: { kind: 'error', detail: 'offline' } }),
    close: async () => {},
    closeAll: async () => {},
  }),
}));
vi.mock('../threads/cache', async () => {
  const { memoryMailCache } = await import('@yozz.app/mail/testing/memory-mail-cache');
  return {
    createMailCache: (_userId: string, address: string) => {
      const cache = mocks.caches.get(address) ?? memoryMailCache();
      mocks.caches.set(address, cache);
      return cache;
    },
    clearMailCache: async () => {},
  };
});
vi.mock('@yozz.app/mail/threads/sync', () => ({
  syncMailbox: mocks.syncMailbox,
  loadOlder: async () => ({ ok: true, value: { loaded: 0, complete: false } }),
  prefetchBodies: () => {},
}));

// This jsdom exposes no `localStorage`; the lock's teardown clears the device draft from it.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const ADDRESS: InboundAddress = {
  address: 'me@x.co',
  imap: { host: 'imap.x.co', port: 993, username: 'me@x.co', password: 'pw' },
  smtp: { host: 'smtp.x.co', port: 465, username: 'me@x.co', password: 'pw' },
};

const summary = (uid: number): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags: [],
  internalDate: '01-Jan-2026 00:00:00 +0000',
  size: 1,
  envelope: {
    date: 'Thu, 1 Jan 2026 00:00:00 +0000',
    subject: `Subject ${uid}`,
    subjectRaw: null,
    from: [{ name: null, mailbox: 'ann', host: 'y.co' }],
    sender: [],
    replyTo: [],
    to: [{ name: null, mailbox: 'me', host: 'x.co' }],
    cc: [],
    bcc: [],
    inReplyTo: null,
    messageId: `<${uid}@y.co>`,
  },
  references: [],
  gmailThreadId: null,
  attachmentNames: [],
});

/** What a sync of the inbox leaves in a device's cache. */
const syncInto = async (cache: MailCache, uids: readonly number[]) => {
  await cache.folder('inbox').putSummaries(uids.map(summary));
  await cache
    .folder('inbox')
    .putSync({ name: 'INBOX', uidValidity: 1, lastUid: Math.max(...uids), complete: true });
};

const latest: { mail?: ReturnType<typeof useMail> } = {};
const Probe = () => {
  latest.mail = useMail();
  return null;
};
const subjects = () => (latest.mail?.threads ?? []).map(({ subject }) => subject).toSorted();

const unmounts: (() => Promise<void>)[] = [];
const mount = async (vault: { store: RecordStore; files: FileStore }) => {
  await vault.store.put({
    type: ADDRESS_RECORD_TYPE,
    naturalKey: ADDRESS.address,
    plaintext: JSON.stringify(ADDRESS),
  });
  mocks.session = { userId: 'user', ...vault };
  const root = createRoot(document.createElement('div'));
  unmounts.push(() => act(async () => root.unmount()));
  await act(async () =>
    root.render(
      <MailProvider>
        <Probe />
      </MailProvider>,
    ),
  );
};

beforeEach(() => {
  mocks.caches.clear();
  mocks.syncMailbox.mockReset();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

it('a device with no cache shows the list another device saved, before its sync answers', async () => {
  const { store } = fakeRecordStore();
  const { store: files } = fakeFileStore();
  const laptop = memoryMailCache();
  await syncInto(laptop, [1, 2]);
  expect(await createSnapshotWriter({ store, files }).save(ADDRESS, laptop)).toBe('saved');
  // The server never answers.
  mocks.syncMailbox.mockReturnValue(new Promise(() => {}));

  await mount({ store, files });

  await vi.waitFor(() => expect(subjects()).toEqual(['Subject 1', 'Subject 2']));
  // The sync then runs over the restored cache, which it reads on from.
  await vi.waitFor(() => expect(mocks.syncMailbox).toHaveBeenCalledOnce());
  expect(mocks.syncMailbox.mock.calls[0]?.[1]).toBe(mocks.caches.get(ADDRESS.address));
});

it('saves the list to the vault once a sync has landed', async () => {
  const { store } = fakeRecordStore();
  const { store: files, files: stored } = fakeFileStore();
  mocks.syncMailbox.mockImplementation(async (_run: unknown, cache: MailCache) => {
    await syncInto(cache, [1, 2, 3]);
    return {
      state: { status: 'synced', at: 1, complete: ['inbox'] },
      byFolder: { inbox: { uidValidity: 1, summaries: [1, 2, 3].map(summary) } },
      scope: 'all',
    };
  });

  await mount({ store, files });

  await vi.waitFor(async () =>
    expect(await store.get(CACHE_SNAPSHOT_RECORD_TYPE, ADDRESS.address)).not.toBeNull(),
  );
  expect(stored.size).toBe(1);
});
