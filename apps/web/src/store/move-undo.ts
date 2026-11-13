import type { MoveTarget } from '@yozz.app/mail/threads/reconcile';
import type { Folder } from '@yozz.app/mail/threads/thread';
import { reportDone, reportProblem } from '../ui/Toast';

/** What a move a person made is called once it is done: alone, and after a count. */
const DONE: Record<MoveTarget, string> = {
  archive: 'Archived',
  trash: 'Moved to Trash',
  junk: 'Moved to Junk',
  inbox: 'Moved to Inbox',
};

export const moveDoneTitle = (to: MoveTarget, count: number) =>
  count === 1 ? DONE[to] : `${count} ${DONE[to].charAt(0).toLowerCase()}${DONE[to].slice(1)}`;

/**
 * The moves that put a thread back where it was before it moved to `to`, in order. Only the inbox
 * takes mail out of Trash and Junk, so the way back to Archive or Junk goes through it.
 *
 * ponytail: it goes by the conversation, not by each copy, as the moves themselves do: a thread
 * with copies in two folders comes back in one, and your own Sent copy comes back from Trash to the
 * inbox, which is where Restore puts it too. Un-park when seen.
 */
export const wayBack = (before: readonly Folder[], to: MoveTarget): readonly MoveTarget[] => {
  if (to === 'inbox') {
    if (before.includes('trash')) return ['trash'];
    return before.includes('archive') ? ['archive'] : ['junk'];
  }
  if (to === 'archive' || before.includes('inbox')) return ['inbox'];
  if (before.includes('archive')) return ['inbox', 'archive'];
  return to === 'trash' && before.includes('junk') ? ['inbox', 'junk'] : ['inbox'];
};

/**
 * Says a move happened and offers the way back. `move` must see each step's result before the
 * next one runs, since the second step moves what the first one brought to the inbox.
 */
export const reportMoved = (
  moved: readonly {
    readonly id: string;
    readonly subject: string;
    readonly folders: readonly Folder[];
  }[],
  to: MoveTarget,
  move: (
    threadIds: readonly string[],
    to: MoveTarget,
    onRefused: (reason: string) => void,
  ) => unknown,
) => {
  const [only] = moved;
  if (only === undefined) return;
  // The screen has moved on by the time this is read, so one thread is named; several are a count.
  const detail = moved.length === 1 && only.subject.trim() !== '' ? only.subject : undefined;
  reportDone(
    moveDoneTitle(to, moved.length),
    {
      label: 'Undo',
      onAction: () => {
        let isRefusalReported = false;
        const ways = moved.map(({ id, folders }) => ({ id, steps: wayBack(folders, to) }));
        // One write per way back, however many threads take it.
        for (const [, threads] of Map.groupBy(ways, ({ steps }) => steps.join())) {
          for (const step of threads[0]?.steps ?? []) {
            move(
              threads.map(({ id }) => id),
              step,
              reason => {
                if (isRefusalReported) return;
                isRefusalReported = true;
                reportProblem('Not undone', reason);
              },
            );
          }
        }
      },
    },
    detail,
  );
};
