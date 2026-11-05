import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { memoryMailCache } from '../testing/memory-mail-cache.ts';
import { cachedPreviews, cachedSummaries, withExtra } from './hydrate.ts';

const summary = (uid: number): ImapMessageSummary => ({
  seq: uid,
  uid,
  flags: ['\\Seen'],
  internalDate: '23-Aug-2026 09:00:00 +0000',
  size: 100,
  envelope: null,
  references: ['<a@x>'],
  gmailThreadId: null,
  attachmentNames: [],
});

const body = (paragraphs: string[]) => ({
  paragraphs,
  hasTextPart: true,
  htmlSaysMore: false,
  inlineImagesTruncated: false,
  attachments: [],
  dkim: null,
});

describe('hydration from the mail cache', () => {
  it('reads every folder, with UIDVALIDITY 0 standing in where nothing was synced', async () => {
    const mailbox = memoryMailCache();
    const inbox = mailbox.folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 42, lastUid: 2, complete: true });
    await inbox.putSummaries([summary(1), summary(2)]);
    const sent = mailbox.folder('sent');
    await sent.putSync({ name: 'Sent', uidValidity: 99, lastUid: 10, complete: false });
    await sent.putSummaries([summary(10)]);

    const byFolder = await cachedSummaries(mailbox);
    expect(byFolder.inbox?.uidValidity).toBe(42);
    expect(byFolder.inbox?.summaries.map(s => s.uid)).toEqual([1, 2]);
    expect(byFolder.sent?.uidValidity).toBe(99);
    expect(byFolder.sent?.summaries.map(s => s.uid)).toEqual([10]);
    expect(byFolder.archive).toEqual({ uidValidity: 0, summaries: [] });
  });

  it("keys each cached body's text by its location, and skips a folder with no sync mark", async () => {
    const mailbox = memoryMailCache();
    const inbox = mailbox.folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 12, lastUid: 3, complete: true });
    await inbox.putBody(3, body(['Preview snippet one', 'Paragraph two']));
    const sent = mailbox.folder('sent');
    await sent.putSync({ name: 'Sent', uidValidity: 34, lastUid: 7, complete: false });
    await sent.putBody(7, body(['Sent message snippet']));
    // A body with no UIDVALIDITY to key it by cannot be placed.
    await mailbox.folder('archive').putBody(5, body(['unplaceable']));

    expect(await cachedPreviews(mailbox, 'me@x')).toEqual({
      'me@x/inbox/12/3': ['Preview snippet one', 'Paragraph two'],
      'me@x/sent/34/7': ['Sent message snippet'],
    });
  });

  describe('withExtra', () => {
    const uids = (folders: ReturnType<typeof withExtra>) =>
      folders.inbox?.summaries.map(s => s.uid);

    it('lays added summaries over the cached ones read under the same UIDVALIDITY', () => {
      const cached = { inbox: { uidValidity: 7, summaries: [summary(1), summary(2)] } };
      expect(
        uids(withExtra(cached, { inbox: { uidValidity: 7, summaries: [summary(9)] } })),
      ).toEqual([1, 2, 9]);
    });

    it('keeps the cached ones when the folder was renumbered since', () => {
      const cached = { inbox: { uidValidity: 7, summaries: [summary(1)] } };
      expect(
        uids(withExtra(cached, { inbox: { uidValidity: 8, summaries: [summary(9)] } })),
      ).toEqual([1]);
    });

    it('keeps an empty folder read since under a new UIDVALIDITY clear of older found ones', () => {
      const cached = { inbox: { uidValidity: 8, summaries: [] } };
      expect(withExtra(cached, { inbox: { uidValidity: 7, summaries: [summary(9)] } })).toEqual(
        cached,
      );
    });

    it('takes the added ones into a folder never read, whatever stood in for it', () => {
      const cached = { inbox: { uidValidity: 0, summaries: [] } };
      expect(withExtra(cached, { inbox: { uidValidity: 8, summaries: [summary(9)] } })).toEqual({
        inbox: { uidValidity: 8, summaries: [summary(9)] },
      });
    });
  });
});
