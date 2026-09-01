import { buildMessage } from '@yozz.app/smtp';
import type { MailConnectionFailure, Result } from '../mail/connection';
import type { LiveClient, LiveTask } from '../mail/live';
import { MINUTES_APART, seedFixtures, seedMessageId } from './fixtures';

/**
 * HACKATHON ONLY: delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 *
 * Wipes every folder and appends the fifteen fixtures fresh, over the connection the app holds.
 * The judge's own mail does not survive; the banner says so and a confirm sheet asks first.
 * Server-side twin: `harness/judge-reseed.ts`.
 */

export type ResetOutcome = {
  readonly wiped: number;
  readonly appended: number;
  /** Fixtures that are not where they belong. */
  readonly missing: readonly string[];
};

export const resetJudgeInbox = (owner: string): LiveTask<ResetOutcome> => ({
  priority: 'user',
  // A re-run APPEND duplicates the message; a reset is cheap to ask for again by hand.
  retry: false,
  run: async (client: LiveClient): Promise<Result<ResetOutcome, MailConnectionFailure>> => {
    const listed = await client.list('', '*');
    if (!listed.ok) return { ok: false, error: { kind: 'imap', reason: listed.reason } };
    // A \Noselect entry is hierarchy, not a mailbox; SELECTing it refuses.
    const boxes = listed.value.filter(
      box => !box.attributes.some(a => a.toLowerCase() === '\\noselect'),
    );
    const sent = boxes.find(box => box.attributes.some(a => a.toLowerCase() === '\\sent'))?.name;
    // Found out before the wipe: no Sent folder means the thread stops spanning two folders.
    if (sent === undefined) {
      return { ok: false, error: { kind: 'error', detail: 'no \\Sent folder' } };
    }

    // Every refusal aborts before a fixture is appended; appending onto a half-done wipe duplicates the fifteen on top of the strays.
    let wiped = 0;
    for (const box of boxes.map(b => b.name)) {
      const selected = await client.select(box);
      if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
      if (selected.value.exists === 0) continue;
      const all = await client.fetchSummariesBySeq(`1:${selected.value.exists}`);
      if (!all.ok) return { ok: false, error: { kind: 'imap', reason: all.reason } };
      if (all.value.length === 0) continue;
      const uids = all.value.map(m => m.uid).join(',');
      const flagged = await client.storeFlags(uids, 'add', ['\\Deleted']);
      if (!flagged.ok) return { ok: false, error: { kind: 'imap', reason: flagged.reason } };
      const expunged = await client.uidExpunge(uids);
      if (!expunged.ok) return { ok: false, error: { kind: 'imap', reason: expunged.reason } };
      wiped += all.value.length;
    }

    const fixtures = seedFixtures(owner);
    const now = Date.now();
    let appended = 0;
    const missing: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const { slug, box, unread, ...message } = fixture;
      const home = box === 'sent' ? sent : 'INBOX';
      const date = new Date(now - (fixtures.length - index) * MINUTES_APART * 60_000);
      const raw = buildMessage({
        ...message,
        to: [owner],
        date,
        messageId: seedMessageId(slug),
      });
      const result = await client.append(home, raw, unread === true ? [] : ['\\Seen'], date);
      if (result.ok) appended += 1;
      else missing.push(slug);
    }

    return { ok: true, value: { wiped, appended, missing } };
  },
});
