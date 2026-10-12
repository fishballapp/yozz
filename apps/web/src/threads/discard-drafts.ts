import type { useMail } from '../store/MailProvider';
import { reportProblem } from '../ui/Toast';
import type { ThreadState } from './thread';

type RemoveDraft = ReturnType<typeof useMail>['removeDraft'];

/** Every way `removeDraft` can answer, minus the two that mean the draft is gone and the one nobody hears. */
type DiscardOutcome = Exclude<
  Awaited<ReturnType<RemoveDraft>>['outcome'],
  'deleted' | 'absent' | 'ended'
>;

/** Each refusal names a different thing to do next. */
const DISCARD_REFUSALS: Record<DiscardOutcome, string> = {
  busy: 'It is open in the composer — close that first.',
  sending: 'It is being sent right now.',
  conflict: 'Another device changed it since this list was built. Reload and try again.',
  locked: "You're signed out.",
  offline: 'YOZZ could not be reached. Check your connection and try again.',
};

/** Every draft in each conversation: two replies drafted in one thread are one row. */
export const draftIdsOf = (threads: readonly ThreadState[]): string[] =>
  threads.flatMap(thread =>
    thread.messages.flatMap(({ isDraft, draftId }) =>
      isDraft === true && draftId !== undefined ? [draftId] : [],
    ),
  );

/** The confirm counts what it throws away. */
export const discardTitle = (count: number): string =>
  count === 1 ? 'Discard this draft?' : `Discard ${count} drafts?`;

/** Discards every draft, and says what refused once, however many did. */
export const discardDrafts = async (
  removeDraft: RemoveDraft,
  draftIds: readonly string[],
): Promise<void> => {
  const outcomes = await Promise.all(draftIds.map(draftId => removeDraft(draftId)));
  for (const { outcome } of outcomes) {
    if (outcome === 'deleted' || outcome === 'absent' || outcome === 'ended') continue;
    reportProblem(
      draftIds.length === 1 ? 'Draft not discarded' : 'Not every draft discarded',
      DISCARD_REFUSALS[outcome],
    );
    return;
  }
};
