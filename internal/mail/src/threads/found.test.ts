import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import {
  flagAfterWrite,
  foundAfterMoves,
  hasMoreMatches,
  matchesFrontier,
  withFound,
} from './found.ts';
import { threadList } from './hydrate.ts';
import { threadsIn } from './views.ts';

const summary = (uid: number, flags: readonly string[] = []): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags,
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
const inInbox = (...summaries: readonly ImapMessageSummary[]) => ({
  inbox: { uidValidity: 1, summaries },
});

describe('what searches found', () => {
  it('adds to what earlier searches found, and starts again when a folder was renumbered', () => {
    const matches = {
      folder: 'inbox',
      folderName: 'INBOX',
      uidValidity: 1,
      hits: [2],
      rest: [],
      reachedAt: null,
    } as const;
    const once = withFound(inInbox(summary(1)), { ...matches, summaries: [summary(2)] });
    expect(once.inbox?.summaries.map(({ uid }) => uid)).toEqual([1, 2]);
    const renumbered = withFound(once, { ...matches, uidValidity: 9, summaries: [summary(3)] });
    expect(renumbered.inbox).toMatchObject({ uidValidity: 9 });
    expect(renumbered.inbox?.summaries.map(({ uid }) => uid)).toEqual([3]);
  });

  it('keeps a found copy’s flags as a write left them, since no sync will', () => {
    const targets = [{ folder: 'inbox', uids: [1] }] as const;
    const read = flagAfterWrite(inInbox(summary(1), summary(2)), targets, {
      key: 'isUnread',
      value: false,
    });
    expect(read.inbox?.summaries.map(({ flags }) => flags)).toEqual([['\\Seen'], []]);
    const starred = flagAfterWrite(read, targets, { key: 'isStarred', value: true });
    expect(starred.inbox?.summaries[0]?.flags).toEqual(['\\Seen', '\\Flagged']);
    const unread = flagAfterWrite(starred, targets, { key: 'isUnread', value: true });
    expect(unread.inbox?.summaries[0]?.flags).toEqual(['\\Flagged']);
  });

  it('follows a found copy where a move put it, and forgets one the server did not place', () => {
    const from = { folder: 'inbox', uidValidity: 1, uid: 1 } as const;
    const moved = foundAfterMoves(inInbox(summary(1)), [
      { from, to: { folder: 'archive', uidValidity: 7, uid: 50 } },
    ]);
    expect(moved.inbox?.summaries).toEqual([]);
    expect(moved.archive).toMatchObject({ uidValidity: 7 });
    expect(moved.archive?.summaries[0]).toMatchObject({ uid: 50, flags: [] });

    expect(foundAfterMoves(inInbox(summary(1)), [{ from, to: null }]).inbox?.summaries).toEqual([]);
  });

  it('says when any folder matched more than it read', () => {
    expect(hasMoreMatches([{ matches: [{ rest: [] }] }])).toBe(false);
    expect(hasMoreMatches([{ matches: [{ rest: [] }, { rest: [1] }] }])).toBe(true);
  });
});

describe('matchesFrontier', () => {
  const answer = (
    address: string,
    folder: 'inbox' | 'archive',
    reachedAt: number | null,
    rest: readonly number[],
  ) => ({
    address,
    matches: [
      { folder, folderName: folder, uidValidity: 1, hits: [], summaries: [], rest, reachedAt },
    ],
  });

  it('is the folder that stops soonest, of those with more to read', () => {
    expect(
      matchesFrontier([
        answer('a@x.co', 'inbox', 100, [1]),
        answer('b@x.co', 'archive', 900, [2]),
        answer('c@x.co', 'inbox', null, []),
      ]),
    ).toMatchObject({ mailbox: 'b@x.co', folder: 'archive', reachedAt: 900 });
  });

  it('follows a folder’s newest page, and is null once nothing is left to read', () => {
    const first = answer('a@x.co', 'inbox', 900, [1]);
    expect(matchesFrontier([first])).toMatchObject({ reachedAt: 900 });
    expect(matchesFrontier([first, answer('a@x.co', 'inbox', null, [])])).toBeNull();
  });
});

describe('threadList', () => {
  const byMailbox = { 'me@x.co': inInbox(summary(1)) };
  const found = { 'me@x.co': inInbox(summary(2)) };

  it('threads found mail in, marked, and leaves it out of every view', () => {
    const threads = threadList({ byMailbox, found });
    expect(threads.map(({ subject, isFoundOnly }) => [subject, isFoundOnly])).toEqual(
      expect.arrayContaining([
        ['Subject 1', undefined],
        ['Subject 2', true],
      ]),
    );
    expect(threadsIn(threads, 'unified').map(({ subject }) => subject)).toEqual(['Subject 1']);
  });

  it('does not mark what a sync has since brought into the window', () => {
    const threads = threadList({
      byMailbox: { 'me@x.co': inInbox(summary(1), summary(2)) },
      found,
    });
    expect(threads.every(({ isFoundOnly }) => isFoundOnly === undefined)).toBe(true);
  });

  it('holds found mail for a mailbox with nothing else read yet', () => {
    expect(threadList({ byMailbox: {}, found }).map(({ subject }) => subject)).toEqual([
      'Subject 2',
    ]);
  });
});
