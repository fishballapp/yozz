import 'fake-indexeddb/auto';
import type { ImapMessageSummary } from '@yozz.app/imap';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { clearMailCache, createMailCache } from './cache';

const summary = (uid: number): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags: ['\\Seen'],
  internalDate: '23-Aug-2026 09:00:00 +0000',
  size: 100,
  envelope: null,
  references: ['<a@x>'],
  gmailThreadId: null,
});

describe('mail cache', () => {
  it('keeps summaries, bodies and the sync mark per user, account and folder', async () => {
    const idb = new IDBFactory();
    const account = createMailCache('u1', 'me@x', idb);
    const inbox = account.folder('inbox');
    const sent = account.folder('sent');
    const other = createMailCache('u1', 'other@x', idb).folder('inbox');
    expect(await inbox.getSync()).toBeNull();
    await inbox.putSync({ name: 'INBOX', uidValidity: 7, lastUid: 3, complete: false });
    await inbox.putSummaries([summary(1), summary(3)]);
    // The same uid in another folder is another message.
    await sent.putSummaries([summary(3)]);
    await other.putSummaries([summary(2)]);
    await inbox.putBody(3, {
      paragraphs: ['hi'],
      hasTextPart: true,
      inlineImagesTruncated: false,
      attachments: [],
    });

    expect(await inbox.getSync()).toEqual({
      name: 'INBOX',
      uidValidity: 7,
      lastUid: 3,
      complete: false,
    });
    expect((await inbox.listSummaries()).map(s => s.uid)).toEqual([1, 3]);
    expect((await sent.listSummaries()).map(s => s.uid)).toEqual([3]);
    expect((await inbox.getBody(3))?.paragraphs).toEqual(['hi']);
    expect(await sent.getBody(3)).toBeNull();
    expect(await inbox.getBody(1)).toBeNull();
    expect(await inbox.listPreviews()).toEqual([{ uid: 3, paragraphs: ['hi'] }]);
    expect(await sent.listPreviews()).toEqual([]);

    await inbox.deleteSummaries([1]);
    expect((await inbox.listSummaries()).map(s => s.uid)).toEqual([3]);

    await account.clear();
    expect(await inbox.getSync()).toBeNull();
    expect(await inbox.listSummaries()).toEqual([]);
    expect(await sent.listSummaries()).toEqual([]);
    expect(await inbox.getBody(3)).toBeNull();
    expect(await inbox.listPreviews()).toEqual([]);
    expect((await other.listSummaries()).map(s => s.uid)).toEqual([2]);
  });

  it('a lock clears one user and leaves the other', async () => {
    const idb = new IDBFactory();
    const mine = createMailCache('u1', 'me@x', idb).folder('inbox');
    const theirs = createMailCache('u2', 'me@x', idb).folder('inbox');
    await mine.putSummaries([summary(1)]);
    await mine.putSync({ name: 'INBOX', uidValidity: 1, lastUid: 1, complete: false });
    await theirs.putSummaries([summary(1)]);
    await clearMailCache('u1', idb);
    expect(await mine.listSummaries()).toEqual([]);
    expect(await mine.getSync()).toBeNull();
    expect((await theirs.listSummaries()).map(s => s.uid)).toEqual([1]);
  });
});
