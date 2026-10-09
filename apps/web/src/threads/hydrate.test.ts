import 'fake-indexeddb/auto';
import type { ImapMessageSummary } from '@yozz.app/imap';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createMailCache } from './cache';
import { cachedPreviews, cachedSummaries } from './hydrate';

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

const body = (paragraphs: string[]) => ({
  paragraphs,
  hasTextPart: true,
  inlineImagesTruncated: false,
  attachments: [],
});

describe('hydration from the mail cache', () => {
  it('reads every folder, with UIDVALIDITY 0 standing in where nothing was synced', async () => {
    const account = createMailCache('u1', 'me@x', new IDBFactory());
    const inbox = account.folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 42, lastUid: 2, complete: true });
    await inbox.putSummaries([summary(1), summary(2)]);
    const sent = account.folder('sent');
    await sent.putSync({ name: 'Sent', uidValidity: 99, lastUid: 10, complete: false });
    await sent.putSummaries([summary(10)]);

    const byFolder = await cachedSummaries(account);
    expect(byFolder.inbox?.uidValidity).toBe(42);
    expect(byFolder.inbox?.summaries.map(s => s.uid)).toEqual([1, 2]);
    expect(byFolder.sent?.uidValidity).toBe(99);
    expect(byFolder.sent?.summaries.map(s => s.uid)).toEqual([10]);
    expect(byFolder.archive).toEqual({ uidValidity: 0, summaries: [] });
  });

  it("keys each cached body's text by its location, and skips a folder with no sync mark", async () => {
    const account = createMailCache('u1', 'me@x', new IDBFactory());
    const inbox = account.folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 12, lastUid: 3, complete: true });
    await inbox.putBody(3, body(['Preview snippet one', 'Paragraph two']));
    const sent = account.folder('sent');
    await sent.putSync({ name: 'Sent', uidValidity: 34, lastUid: 7, complete: false });
    await sent.putBody(7, body(['Sent message snippet']));
    // A body with no UIDVALIDITY to key it by cannot be placed.
    await account.folder('archive').putBody(5, body(['unplaceable']));

    expect(await cachedPreviews(account, 'me@x')).toEqual({
      'me@x/inbox/12/3': ['Preview snippet one', 'Paragraph two'],
      'me@x/sent/34/7': ['Sent message snippet'],
    });
  });
});
