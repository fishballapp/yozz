// @vitest-environment jsdom

import type { ImapMessageSummary } from '@yozz.app/imap';
import { ADDRESS_RECORD_TYPE, type AddressRecord } from '@yozz.app/mail/addresses/record';
import { fakeFileStore } from '@yozz.app/mail/testing/fake-file-store';
import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import type { FolderMatches } from '@yozz.app/mail/threads/found';
import { olderFrontier } from '@yozz.app/mail/threads/paging';
import type { FileStore } from '@yozz.app/mail/vault/file-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  session: null as { userId: string; files: FileStore; store: RecordStore } | null,
  cached: {} as object,
  /** What `cachedSummaries` answers for a mailbox, over `cached`. */
  cachedFor: {} as Record<string, object>,
  /** Folders no sync has read on this device; every other has a mark. */
  unread: new Set<string>(),
  syncMailbox: vi.fn(),
  loadOlder: vi.fn(),
  searchMailbox: vi.fn(),
  readMoreMatches: vi.fn(),
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({
    run: async () => ({ ok: false, error: { kind: 'error', detail: 'offline' } }),
    close: async () => {},
    closeAll: async () => {},
  }),
}));
vi.mock('../threads/cache', () => ({
  createMailCache: (_userId: string, address: string) => ({
    address,
    folder: (folder: string) => ({
      address,
      getSync: async () =>
        mocks.unread.has(folder)
          ? null
          : { name: folder, uidValidity: 1, lastUid: 5, complete: false },
    }),
    clear: async () => {},
  }),
  clearMailCache: async () => {},
}));
vi.mock('@yozz.app/mail/threads/hydrate', async importOriginal => ({
  ...(await importOriginal<typeof import('@yozz.app/mail/threads/hydrate')>()),
  cachedSummaries: async (cache: { address: string }) =>
    mocks.cachedFor[cache.address] ?? mocks.cached,
  cachedPreviews: async () => ({}),
}));
vi.mock('@yozz.app/mail/threads/sync', () => ({
  syncMailbox: mocks.syncMailbox,
  loadOlder: mocks.loadOlder,
  prefetchBodies: () => {},
}));
vi.mock('@yozz.app/mail/threads/search', () => ({
  searchMailbox: mocks.searchMailbox,
  readMoreMatches: mocks.readMoreMatches,
}));

// This jsdom exposes no `localStorage`; the lock's teardown clears the device draft from it.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const ADDRESS: AddressRecord = {
  address: 'me@x.co',
  imap: { host: 'imap.x.co', port: 993, username: 'me@x.co', password: 'pw' },
  smtp: { host: 'smtp.x.co', port: 465, username: 'me@x.co', password: 'pw' },
};

const summary = (uid: number): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags: [],
  internalDate: '01-Jan-2020 00:00:00 +0000',
  size: 1,
  envelope: {
    date: 'Wed, 1 Jan 2020 00:00:00 +0000',
    subject: `Subject ${uid}`,
    subjectRaw: null,
    from: [{ name: null, mailbox: 'x', host: 'x.co' }],
    sender: [],
    replyTo: [],
    to: [{ name: null, mailbox: 'me', host: 'x.co' }],
    cc: [],
    bcc: [],
    inReplyTo: null,
    messageId: `<${uid}@x.co>`,
  },
  references: [],
  gmailThreadId: null,
  attachmentNames: [],
});

const INBOX_HELD = { inbox: { uidValidity: 1, summaries: [summary(5)] } };
const synced = (complete: readonly string[]) => ({
  state: { status: 'synced', at: 1, complete },
  byFolder: INBOX_HELD,
  scope: 'all',
});
const FAILURE = { kind: 'stalled' } as const;

const latest: { mail?: ReturnType<typeof useMail> } = {};
const mail = () => {
  if (latest.mail === undefined) throw new Error('MailProvider has not rendered');
  return latest.mail;
};
const Probe = () => {
  latest.mail = useMail();
  return null;
};

const unmounts: (() => Promise<void>)[] = [];
const mount = async (addresses: readonly AddressRecord[] = [ADDRESS]) => {
  const { store } = fakeRecordStore();
  for (const address of addresses) {
    await store.put({
      type: ADDRESS_RECORD_TYPE,
      naturalKey: address.address,
      plaintext: JSON.stringify(address),
    });
  }
  mocks.session = { userId: 'user', files: fakeFileStore().store, store };
  const root = createRoot(document.createElement('div'));
  unmounts.push(() => act(async () => root.unmount()));
  await act(async () =>
    root.render(
      <MailProvider>
        <Probe />
      </MailProvider>,
    ),
  );
  await vi.waitFor(() => expect(mail().mailboxes).toHaveLength(addresses.length));
};

const syncStatus = () => mail().syncStates[ADDRESS.address]?.status;

/** A search whose one folder answered with `rest` still to read, and every server done. */
const searched = async (matches: Partial<FolderMatches> = {}) => {
  mocks.searchMailbox.mockImplementation(
    async ({ onMatches }: { onMatches: (found: FolderMatches) => void }) => {
      onMatches({
        folder: 'inbox',
        folderName: 'INBOX',
        uidValidity: 1,
        hits: [9],
        summaries: [summary(9)],
        rest: [8],
        reachedAt: 1,
        ...matches,
      });
      return { ok: true, value: [] };
    },
  );
  await act(async () => mail().search.now('word'));
  await vi.waitFor(() => expect(mail().serverSearch?.phase).toBe('settled'));
};

beforeEach(() => {
  mocks.cached = INBOX_HELD;
  mocks.cachedFor = {};
  mocks.unread = new Set();
  mocks.loadOlder.mockReset();
  mocks.syncMailbox.mockReset().mockResolvedValue(synced([]));
  mocks.searchMailbox.mockReset();
  mocks.readMoreMatches.mockReset();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

describe('how far a list across folders can reach', () => {
  it('stops at a synced folder holding older mail', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    expect(olderFrontier(mail().windows)).toMatchObject({ mailbox: ADDRESS.address });
  });

  it('is not stopped by a folder already read to its start', async () => {
    mocks.syncMailbox.mockResolvedValue(synced(['inbox']));
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    expect(olderFrontier(mail().windows)).toBeNull();
  });

  it('is not stopped by a mailbox still syncing', async () => {
    mocks.syncMailbox.mockReturnValue(new Promise(() => {}));
    await mount();
    await vi.waitFor(() => expect(mail().windows).not.toEqual([]));
    expect(olderFrontier(mail().windows)).toBeNull();
  });

  it('is not stopped by a mailbox that failed, offline for one', async () => {
    mocks.syncMailbox.mockResolvedValue({ state: { status: 'failed', failure: FAILURE } });
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('failed'));
    await vi.waitFor(() => expect(mail().windows).not.toEqual([]));
    expect(olderFrontier(mail().windows)).toBeNull();
  });
});

describe('older mail across two mailboxes whose windows were both emptied', () => {
  const OTHER: AddressRecord = { ...ADDRESS, address: 'you@x.co' };

  it('reads the second after the first, though both reach as far as nothing', async () => {
    const emptied = { inbox: { uidValidity: 1, summaries: [] } };
    mocks.cached = emptied;
    mocks.syncMailbox.mockResolvedValue({
      state: { status: 'synced', at: 1, complete: ['sent', 'archive', 'trash', 'drafts'] },
      byFolder: emptied,
      scope: 'all',
    });
    mocks.loadOlder.mockImplementation(async (_run, folderCache: { address: string }) => {
      mocks.cachedFor[folderCache.address] = INBOX_HELD;
      return { ok: true, value: { loaded: 1, complete: false } };
    });
    await mount([ADDRESS, OTHER]);
    await vi.waitFor(() => expect(mail().syncStates[OTHER.address]?.status).toBe('synced'));
    await vi.waitFor(() => expect(mail().syncStates[ADDRESS.address]?.status).toBe('synced'));

    await act(async () => mail().loadOlderInList('in:anywhere'));

    const loaded = mocks.loadOlder.mock.calls.map(([, folderCache]) => folderCache.address);
    expect(new Set(loaded)).toEqual(new Set([ADDRESS.address, OTHER.address]));
  });
});

describe('a page of search matches', () => {
  const pressOlder = () => act(async () => mail().loadOlderInList('word'));
  const NEXT_PAGE = {
    folder: 'inbox',
    folderName: 'INBOX',
    uidValidity: 1,
    hits: [8],
    summaries: [summary(8)],
    rest: [],
    reachedAt: null,
  };

  it('that fails says so as older mail would, and is no failed search', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    await searched();
    mocks.readMoreMatches.mockResolvedValue({ ok: false, error: FAILURE });

    await pressOlder();

    expect(mail().mailError).toContain('older mail not loaded · ');
    expect(mail().mailError).toContain('imap.x.co');
    expect(mail().serverSearch?.failed).toEqual([]);
    expect(mail().isLoadingOlderInList).toBe(false);
  });

  it('that fails can be pressed again, and the line clears when it reads', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    await searched();
    mocks.readMoreMatches.mockResolvedValueOnce({ ok: false, error: FAILURE });
    await pressOlder();

    mocks.readMoreMatches.mockResolvedValueOnce({ ok: true, value: NEXT_PAGE });
    await pressOlder();

    expect(mail().mailError).toBeNull();
    expect(mocks.searchMailbox).toHaveBeenCalledTimes(1);
    expect(mail().serverSearch?.answers.at(-1)?.matches[0]?.hits).toEqual([8]);
  });

  it('that throws reports the same, and lets go of the loading flag', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    await searched();
    mocks.readMoreMatches.mockRejectedValue(new Error('chunk went away'));

    await pressOlder();

    expect(mail().mailError).toContain('older mail not loaded · ');
    expect(mail().isLoadingOlderInList).toBe(false);
  });
});

describe('a folder renumbered under what a search found', () => {
  it('forgets what was found in that mailbox, as its uids no longer name anything', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    await searched({ rest: [], reachedAt: null });
    expect(mail().threads.map(({ subject }) => subject)).toContain('Subject 9');

    mocks.syncMailbox.mockResolvedValue({
      state: { status: 'failed', failure: FAILURE, invalidated: true },
    });
    await act(async () => mail().sync(ADDRESS.address));

    await vi.waitFor(() => expect(syncStatus()).toBe('failed'));
    expect(mail().threads.map(({ subject }) => subject)).not.toContain('Subject 9');
  });
});

describe('a search while the mailbox syncs', () => {
  const askedServer = () => mocks.searchMailbox.mock.calls.length > 0;

  it('asks the server at once when every folder it searches has been read', async () => {
    await mount();
    await vi.waitFor(() => expect(syncStatus()).toBe('synced'));
    // Coming back to the tab: a sync that takes as long as a slow server makes it.
    mocks.syncMailbox.mockReturnValue(new Promise(() => {}));
    await act(async () => {
      void mail().sync(ADDRESS.address);
    });
    mocks.searchMailbox.mockResolvedValue({ ok: true, value: [] });

    await act(async () => mail().search.now('word'));

    await vi.waitFor(() => expect(askedServer()).toBe(true));
  });

  it('waits for the sync when a folder it searches has not been read on this device', async () => {
    mocks.unread = new Set(['sent']);
    const { promise: first, resolve } = Promise.withResolvers<unknown>();
    mocks.syncMailbox.mockReturnValue(first);
    await mount();
    mocks.searchMailbox.mockResolvedValue({ ok: true, value: [] });

    await act(async () => mail().search.now('word'));
    await act(async () => {
      await new Promise(settle => setTimeout(settle, 20));
    });
    expect(askedServer()).toBe(false);

    await act(async () => resolve(synced([])));
    await vi.waitFor(() => expect(askedServer()).toBe(true));
  });
});
