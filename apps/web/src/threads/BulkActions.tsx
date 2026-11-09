import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  type Icon,
  MailboxIcon,
  StarIcon,
  TrashIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { type MoveTarget, movesOffered } from '@yozz.app/mail/threads/reconcile';
import type { ThreadState } from '@yozz.app/mail/threads/thread';
import { isOnServer, isTrashed } from '@yozz.app/mail/threads/thread';
import type { ViewId } from '@yozz.app/mail/threads/views';
import { Fragment } from 'react';
import { DISCARD_WARNING } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { reportProblem } from '../ui/Toast';
import { discardableDraftIds, discardDrafts, discardTitle } from './discard-drafts';
import { JUNK_COPY } from './junk-copy';
import { useAdvancePast } from './use-advance';

/** What the bar over the list does to every ticked thread; a group is set off by a rule. */
type BulkAction = {
  readonly icon: Icon;
  /** A set star shows filled, as the row's does. */
  readonly isFilled?: boolean;
  readonly label: string;
  readonly act: () => unknown;
  readonly confirm?: { readonly title: string; readonly description: string };
};

/**
 * The row's own actions, over many threads: each acts on the ticked threads it can and is not
 * offered when none can. Read and star follow Gmail: while any ticked thread is unread the button
 * marks them read, and while any is unstarred it stars them.
 */
const useBulkActions = (
  threads: readonly ThreadState[],
  view: ViewId,
  openId: string | undefined,
  onDone: () => void,
): readonly { readonly key: string; readonly actions: readonly BulkAction[] }[] => {
  const { moveThreads, flagThreads, junkFolders, removeDraft } = useMail();
  const advancePast = useAdvancePast();
  const navigate = useNavigate();

  // One write for the whole batch. Filing the open thread moves the reader on, past every other
  // thread filed with it.
  const file = (candidates: readonly ThreadState[], to: MoveTarget, notFiled: string) => () => {
    const filed = moveThreads(
      candidates.map(({ id }) => id),
      to,
      reason => reportProblem(notFiled, reason),
    );
    if (openId !== undefined && filed.has(openId)) advancePast(openId, filed);
    onDone();
  };

  const draftIds = discardableDraftIds(threads, view);
  const discard =
    draftIds.length === 0
      ? []
      : [
          {
            key: 'discard',
            actions: [
              {
                icon: TrashIcon,
                label: 'Discard drafts',
                confirm: {
                  title: discardTitle(draftIds.length),
                  description: DISCARD_WARNING,
                },
                act: async () => {
                  await discardDrafts(removeDraft, draftIds);
                  onDone();
                },
              },
            ],
          },
        ];
  if (view === 'drafts') return discard;

  // A just-sent message or vault-held sent mail alone: no server holds a copy to change.
  const onServer = threads.filter(isOnServer);
  // By what each thread holds, wherever the list is: a search can tick mail in Trash beside mail not.
  const offering = (move: keyof ReturnType<typeof movesOffered>) =>
    onServer.filter(thread => movesOffered(thread, junkFolders)[move]);

  const restorable = offering('canRestore');
  const restore: BulkAction[] =
    restorable.length > 0
      ? [
          {
            icon: ArrowCounterClockwiseIcon,
            label: 'Restore',
            act: file(restorable, 'inbox', 'Not every thread restored'),
          },
        ]
      : [];
  // All in Trash, there is nothing else to do with them until they are out of it.
  if (onServer.length > 0 && onServer.every(isTrashed)) {
    return [{ key: 'restore', actions: restore }, ...discard];
  }

  const archivable = offering('canArchive');
  // Out of Archive or out of Junk, it is one move to the inbox, so one action.
  const filed = [...offering('canMoveToInbox'), ...offering('canMoveOutOfJunk')];
  const junkable = offering('canMoveToJunk');
  const trashable = offering('canDelete');
  const unread = onServer.filter(thread => thread.isUnread);
  const unstarred = onServer.filter(thread => !thread.isStarred);
  const flag =
    (candidates: readonly ThreadState[], key: 'isUnread' | 'isStarred', value: boolean) => () => {
      flagThreads(
        candidates.map(({ id }) => id),
        key,
        value,
      );
      onDone();
    };

  const moves: BulkAction[] = [
    ...restore,
    ...(archivable.length > 0
      ? [
          {
            icon: ArchiveIcon,
            label: 'Archive',
            act: file(archivable, 'archive', 'Not every thread archived'),
          },
        ]
      : []),
    ...(filed.length > 0
      ? [
          {
            icon: MailboxIcon,
            label: 'Move to inbox',
            act: file(filed, 'inbox', 'Not every thread moved to inbox'),
          },
        ]
      : []),
    ...(junkable.length > 0
      ? [
          {
            icon: WarningOctagonIcon,
            label: JUNK_COPY.moveToJunk,
            act: file(junkable, 'junk', JUNK_COPY.notEveryMovedToJunk),
          },
        ]
      : []),
    ...(trashable.length > 0
      ? [
          {
            icon: TrashIcon,
            label: 'Delete',
            act: file(trashable, 'trash', 'Not every thread deleted'),
          },
        ]
      : []),
  ];
  const marks: BulkAction[] =
    onServer.length === 0
      ? []
      : [
          unread.length > 0
            ? {
                icon: EnvelopeOpenIcon,
                label: 'Mark as read',
                act: flag(unread, 'isUnread', false),
              }
            : {
                icon: EnvelopeSimpleIcon,
                label: 'Mark as unread',
                act: () => {
                  // As the reader's own button does: left open, it would be marked read again.
                  if (openId !== undefined && onServer.some(({ id }) => id === openId)) {
                    void navigate({
                      to: '/m/$view',
                      params: { view },
                      search: previous => previous,
                    });
                  }
                  flag(onServer, 'isUnread', true)();
                },
              },
          unstarred.length > 0
            ? { icon: StarIcon, label: 'Star', act: flag(unstarred, 'isStarred', true) }
            : {
                icon: StarIcon,
                isFilled: true,
                label: 'Unstar',
                act: flag(onServer, 'isStarred', false),
              },
        ];
  return [{ key: 'moves', actions: moves }, { key: 'marks', actions: marks }, ...discard].filter(
    ({ actions }) => actions.length > 0,
  );
};

export const BulkActions = ({
  threads,
  view,
  openId,
  onDone,
}: {
  threads: readonly ThreadState[];
  view: ViewId;
  openId: string | undefined;
  onDone: () => void;
}) => {
  const groups = useBulkActions(threads, view, openId, onDone);

  return groups.map(({ key, actions }, index) => (
    <Fragment key={key}>
      {index > 0 && <span aria-hidden className="mx-1.5 h-5 w-px bg-rule" />}
      {actions.map(({ icon: Mark, isFilled = false, label, act, confirm }) => {
        const button = (
          <Button
            variant="ghost"
            size="icon"
            className="size-11 lg:size-7"
            {...(confirm === undefined ? { onClick: () => void act() } : {})}
            aria-label={label}
          >
            <Mark size={15} weight={isFilled ? 'fill' : 'regular'} />
          </Button>
        );
        return confirm === undefined ? (
          <Fragment key={label}>{button}</Fragment>
        ) : (
          <ConfirmDialog
            key={label}
            trigger={button}
            title={confirm.title}
            description={confirm.description}
            confirmLabel="Discard"
            busyLabel="Discarding…"
            onConfirm={async () => void (await act())}
          />
        );
      })}
    </Fragment>
  ));
};
