import type { ImapMessageSummary } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { type FolderWindow, olderFrontier, windowsOf } from './paging.ts';

const summary = (uid: number, internalDate: string): ImapMessageSummary =>
  ({ uid, seq: uid, internalDate }) as ImapMessageSummary;

const window = (
  folder: FolderWindow['folder'],
  summaries: readonly ImapMessageSummary[],
  isComplete = false,
): FolderWindow => ({ mailbox: 'me@x.co', folder, summaries, isComplete });

describe('olderFrontier', () => {
  it('is the folder that stops short soonest, by the lowest uid it holds', () => {
    const frontier = olderFrontier([
      window('inbox', [
        summary(5, '01-Mar-2026 09:00:00 +0000'),
        summary(9, '01-Jun-2026 09:00:00 +0000'),
      ]),
      window('archive', [summary(2, '01-Jan-2026 09:00:00 +0000')]),
    ]);
    expect(frontier).toEqual({
      mailbox: 'me@x.co',
      folder: 'inbox',
      reachedAt: Temporal.Instant.from('2026-03-01T09:00:00Z').epochMilliseconds,
    });
  });

  it('is null when every folder is complete', () => {
    expect(olderFrontier([window('inbox', [], true)])).toBeNull();
  });

  it('is the folder itself when triage emptied its window, for it has read none of its mail', () => {
    const frontier = olderFrontier([
      window('inbox', []),
      window('archive', [summary(2, '01-Jan-2026 09:00:00 +0000')]),
    ]);
    expect(frontier).toMatchObject({ folder: 'inbox', reachedAt: Number.POSITIVE_INFINITY });
  });
});

describe('windowsOf', () => {
  it("leaves out the server's Drafts, whose mail no list shows", () => {
    const windows = windowsOf(
      {
        'me@x.co': {
          inbox: { uidValidity: 1, summaries: [] },
          drafts: { uidValidity: 1, summaries: [] },
        },
      },
      () => false,
    );
    expect(windows.map(({ folder }) => folder)).toEqual(['inbox']);
  });
});
