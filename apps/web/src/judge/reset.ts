import { buildMessage } from '@yozz.app/smtp';
import type { MailConnectionFailure, Result } from '../mail/connection';
import type { LiveClient, LiveTask } from '../mail/live';
import { resolveFolders } from '../mail/mailboxes';
import { MINUTES_APART, seedFixtures, seedMessageId } from './fixtures';

/**
 * HACKATHON ONLY — delete this folder after the WebMCP Challenge (deadline 2026-09-03).
 * Tracked as item 0 of HANDOFF.md's Next.
 *
 * Puts a judge's demo mailbox back the way it started, from the browser, over the connection the
 * app already holds. A judge who has archived half the inbox can hand the next one a clean
 * mailbox, and can run the same task twice themselves — which is the case a scheduled reset on our
 * side would not have covered anyway.
 *
 * It never deletes: a stray seed is MOVED home and its flags are set back, and only a seed that is
 * missing outright is appended. So a judge's own sent and received mail survives a reset, and a
 * second reset changes nothing.
 */

export type ResetOutcome = {
  readonly moved: number;
  readonly reflagged: number;
  readonly appended: number;
  /** Fixtures that are not where they belong. A reset with any of these did not restore the demo. */
  readonly missing: readonly string[];
};

const flagsFor = (unread: boolean | undefined) => (unread === true ? [] : ['\\Seen']);

export const resetJudgeInbox = (owner: string): LiveTask<ResetOutcome> => ({
  priority: 'user',
  // An APPEND that is re-run duplicates the message; a reset is cheap to ask for again by hand.
  retry: false,
  run: async (client: LiveClient): Promise<Result<ResetOutcome, MailConnectionFailure>> => {
    const folders = await resolveFolders(client);
    if (!folders.ok) return folders;
    const fixtures = seedFixtures(owner);
    const now = Date.now();
    const homeOf = (box: 'inbox' | 'sent' | undefined) =>
      box === 'sent' ? folders.value.sent : 'INBOX';

    // Where each seed currently is, looked up mailbox by mailbox: a judge may have archived,
    // binned or read any of them, and only the Message-ID survives all three.
    const found = new Map<string, { mailbox: string; uid: number }>();
    for (const mailbox of Object.values(folders.value)) {
      const selected = await client.ensureSelected(mailbox);
      if (!selected.ok) continue;
      for (const { slug } of fixtures) {
        if (found.has(slug)) continue;
        const uids = await client.uidSearchHeader('Message-ID', seedMessageId(slug));
        const uid = uids.ok ? uids.value[uids.value.length - 1] : undefined;
        if (uid !== undefined) found.set(slug, { mailbox, uid });
      }
    }

    let moved = 0;
    let reflagged = 0;
    let appended = 0;
    const missing: string[] = [];

    for (const [index, fixture] of fixtures.entries()) {
      const home = homeOf(fixture.box);
      // No Sent folder means the thread's middle message has nowhere to be, and the conversation
      // the judge is asked to trace stops spanning two folders.
      if (home === undefined) {
        missing.push(fixture.slug);
        continue;
      }
      const at = found.get(fixture.slug);
      const date = new Date(now - (fixtures.length - index) * MINUTES_APART * 60_000);

      if (at === undefined) {
        const { slug: _slug, box: _box, unread, ...message } = fixture;
        const raw = buildMessage({
          ...message,
          to: [owner],
          date,
          messageId: seedMessageId(fixture.slug),
        });
        const result = await client.append(home, raw, flagsFor(unread), date);
        if (result.ok) appended += 1;
        else missing.push(fixture.slug);
        continue;
      }

      if (at.mailbox !== home) {
        const selected = await client.ensureSelected(at.mailbox);
        if (!selected.ok) {
          missing.push(fixture.slug);
          continue;
        }
        const result = await client.move(String(at.uid), home);
        if (!result.ok) {
          missing.push(fixture.slug);
          continue;
        }
        moved += 1;
        // Its uid changed with the move, so the flag pass finds it again by Message-ID below.
        const back = await client.ensureSelected(home);
        if (!back.ok) continue;
        const uids = await client.uidSearchHeader('Message-ID', seedMessageId(fixture.slug));
        const uid = uids.ok ? uids.value[uids.value.length - 1] : undefined;
        if (uid === undefined) continue;
        const flagged = await client.storeFlags(String(uid), 'set', flagsFor(fixture.unread));
        if (flagged.ok) reflagged += 1;
        continue;
      }

      const selected = await client.ensureSelected(home);
      if (!selected.ok) continue;
      const flagged = await client.storeFlags(String(at.uid), 'set', flagsFor(fixture.unread));
      if (flagged.ok) reflagged += 1;
    }

    return { ok: true, value: { moved, reflagged, appended, missing } };
  },
});
