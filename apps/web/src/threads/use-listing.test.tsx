// @vitest-environment jsdom

import type { FolderMatches } from '@yozz.app/mail/threads/found';
import type { ServerSearch } from '@yozz.app/mail/threads/server-search';
import type { ThreadState } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useListing } from './use-listing';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mail = vi.hoisted(() => ({
  threads: [] as ThreadState[],
  mailboxes: [{ address: 'me@x.co' }],
  windows: [],
  serverSearch: null as ServerSearch | null,
  followSearch: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ view: 'unified' }),
  useSearch: () => ({ q: 'word' }),
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const thread = (id: string, at: number, uid: number): ThreadState => ({
  id,
  mailboxes: ['me@x.co'],
  subject: 'word',
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders: ['archive'],
  foldersByMailbox: { 'me@x.co': ['archive'] },
  messages: [
    {
      id: `${id}/1`,
      fromName: 'x',
      fromAddress: 'x@x.co',
      toAddress: 'me@x.co',
      at,
      body: [],
      locations: [{ mailbox: 'me@x.co', folder: 'archive', uidValidity: 1, uid }],
    },
  ],
});
const page: FolderMatches = {
  folder: 'archive',
  folderName: 'Archive',
  uidValidity: 1,
  hits: [20],
  summaries: [],
  rest: [10],
  reachedAt: 500,
};
const search = (phase: ServerSearch['phase'], query = 'word'): ServerSearch => ({
  query,
  phase,
  asking: [],
  answers: [{ address: 'me@x.co', matches: [page] }],
  failed: [],
});

const host = document.createElement('div');
const root = createRoot(host);
const listed = async () => {
  const seen: { current: ReturnType<typeof useListing> } = { current: undefined };
  const Probe = () => {
    seen.current = useListing();
    return null;
  };
  await act(async () => root.render(<Probe />));
  return seen.current;
};

afterEach(async () => {
  await act(async () => root.render(null));
  mail.serverSearch = null;
});

describe('useListing', () => {
  it('offers the next page of matches only once every server has answered', async () => {
    mail.threads = [thread('new', 900, 20)];
    mail.serverSearch = search('asking');
    expect((await listed())?.older).toBeNull();

    mail.serverSearch = search('settled');
    expect((await listed())?.older).toMatchObject({ folder: 'archive', reachedAt: 500 });
  });

  it('keeps rows out below where the read matches stop, until a page reaches them', async () => {
    mail.threads = [thread('new', 900, 20), thread('old', 100, 10)];
    mail.serverSearch = search('settled');
    expect((await listed())?.threads.map(({ id }) => id)).toEqual(['new']);

    mail.serverSearch = {
      ...search('settled'),
      answers: [
        { address: 'me@x.co', matches: [page] },
        { address: 'me@x.co', matches: [{ ...page, hits: [10], rest: [], reachedAt: null }] },
      ],
    };
    const paged = await listed();
    expect(paged?.threads.map(({ id }) => id)).toEqual(['new', 'old']);
    expect(paged?.older).toBeNull();
  });

  it('forgets the matches of a search it has moved on from', async () => {
    mail.threads = [thread('new', 900, 20), thread('old', 100, 10)];
    mail.serverSearch = search('settled', 'an older word');
    const listing = await listed();
    expect(listing?.older).toBeNull();
    expect(listing?.threads.map(({ id }) => id)).toEqual(['new', 'old']);
  });
});
