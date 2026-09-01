import { buildMessage } from '@yozz.app/smtp';
import type { MailConnectionFailure, Result } from '../mail/connection';
import type { LiveClient, LiveTask } from '../mail/live';
import { MINUTES_APART, seedFixtures, seedMessageId } from './fixtures';

/**
 * HACKATHON ONLY — delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 * Tracked as item 0 of HANDOFF.md's Next.
 *
 * Puts a judge's demo mailbox back the way it started, from the browser, over the connection the
 * app already holds. Reset means reset: every folder is wiped and the fifteen fixtures are
 * appended fresh, so two runs of the judge prompt start from byte-identical mailboxes and the
 * strays a run leaves behind (sent replies, delayed DSNs, archived copies) go with the wipe. The
 * banner says so and a confirm sheet asks first — the judge's own mail does NOT survive.
 *
 * The server-side twin is `harness/judge-reseed.ts`, which proved this wipe-then-append shape
 * against Forward Email across all 51 accounts.
 */

export type ResetOutcome = {
  readonly wiped: number;
  readonly appended: number;
  /** Fixtures that are not where they belong. A reset with any of these did not restore the demo. */
  readonly missing: readonly string[];
};

export const resetJudgeInbox = (owner: string): LiveTask<ResetOutcome> => ({
  priority: 'user',
  // An APPEND that is re-run duplicates the message; a reset is cheap to ask for again by hand.
  retry: false,
  run: async (client: LiveClient): Promise<Result<ResetOutcome, MailConnectionFailure>> => {
    const listed = await client.list('', '*');
    if (!listed.ok) return { ok: false, error: { kind: 'imap', reason: listed.reason } };
    // A \Noselect entry is hierarchy, not a mailbox: SELECTing it refuses deterministically,
    // which would abort every reset mid-wipe.
    const boxes = listed.value.filter(
      box => !box.attributes.some(a => a.toLowerCase() === '\\noselect'),
    );
    const sent = boxes.find(box => box.attributes.some(a => a.toLowerCase() === '\\sent'))?.name;
    // No Sent folder means the thread's middle message has nowhere to be, and the conversation
    // the judge is asked to trace stops spanning two folders. Found out BEFORE the wipe — the one
    // ordering worse than refusing is destroying the mailbox and then refusing.
    if (sent === undefined) {
      return { ok: false, error: { kind: 'error', detail: 'no \\Sent folder' } };
    }

    // Every refusal aborts BEFORE a single fixture is appended. Appending onto a wipe that only
    // half happened is the one outcome worse than not running: it leaves the strays this exists
    // to remove AND duplicates the fifteen on top of them.
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
