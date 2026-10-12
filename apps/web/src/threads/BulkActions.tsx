import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  EnvelopeOpenIcon,
  EnvelopeSimpleIcon,
  type Icon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { useNavigate } from '@tanstack/react-router';
import { Fragment } from 'react';
import { DISCARD_WARNING } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { reportProblem } from '../ui/Toast';
import { canMoveTo } from './reconcile';
import { DISCARD_REFUSALS } from './ThreadRow';
import type { ThreadState } from './thread';
import { isOnServer } from './thread';
import { useAdvancePast } from './use-advance';
import type { MailboxId } from './views';

/** What the bar over the list does to every ticked thread; a group is set off by a rule. */
type BulkAction = {
  readonly icon: Icon;
  /** A set star shows filled, as the row's does. */
  readonly isFilled?: boolean;
  readonly label: string;
  readonly act: () => unknown;
  readonly confirm?: { readonly title: string; readonly description: string };
};

/** Reports the first refusal of a batch once, however many of its threads refuse. */
const reportOnce = (title: string) => {
  let isReported = false;
  return (reason: string) => {
    if (isReported) return;
    isReported = true;
    reportProblem(title, reason);
  };
};

/**
 * The row's own actions, over many threads: each acts on the ticked threads it can and is not
 * offered when none can. Read and star follow Gmail: while any ticked thread is unread the button
 * marks them read, and while any is unstarred it stars them.
 */
const useBulkActions = (
  threads: readonly ThreadState[],
  mailbox: MailboxId,
  openId: string | undefined,
  onDone: () => void,
): readonly { readonly key: string; readonly actions: readonly BulkAction[] }[] => {
  const {
    toggleArchive,
    trashThread,
    restoreThread,
    markRead,
    markUnread,
    toggleStar,
    removeDraft,
  } = useMail();
  const advancePast = useAdvancePast();
  const navigate = useNavigate();

  // Filing the open thread moves the reader on, past every other thread filed with it.
  const file =
    (
      candidates: readonly ThreadState[],
      move: (threadId: string, onRefused: (reason: string) => void) => boolean,
      notFiled: string,
    ) =>
    () => {
      const onRefused = reportOnce(notFiled);
      const filed = new Set(candidates.filter(({ id }) => move(id, onRefused)).map(({ id }) => id));
      if (openId !== undefined && filed.has(openId)) advancePast(openId, filed);
      onDone();
    };

  if (mailbox === 'drafts') {
    // Every draft in each conversation: two replies drafted in one thread are one row.
    const draftIds = threads.flatMap(thread =>
      thread.messages.flatMap(({ isDraft, draftId }) =>
        isDraft === true && draftId !== undefined ? [draftId] : [],
      ),
    );
    if (draftIds.length === 0) return [];
    return [
      {
        key: 'discard',
        actions: [
          {
            icon: TrashIcon,
            label: 'Discard drafts',
            confirm: {
              title:
                draftIds.length === 1
                  ? 'Discard this draft?'
                  : `Discard ${draftIds.length} drafts?`,
              description: DISCARD_WARNING,
            },
            act: async () => {
              const onRefused = reportOnce('Not every draft discarded');
              const outcomes = await Promise.all(draftIds.map(draftId => removeDraft(draftId)));
              for (const { outcome } of outcomes) {
                if (outcome === 'deleted' || outcome === 'absent' || outcome === 'ended') continue;
                onRefused(DISCARD_REFUSALS[outcome]);
              }
              onDone();
            },
          },
        ],
      },
    ];
  }

  // A just-sent message or vault-held sent mail alone: no server holds a copy to change.
  const onServer = threads.filter(isOnServer);
  const movable = (to: 'inbox' | 'archive' | 'trash') =>
    onServer.filter(({ folders }) => canMoveTo(folders, to));

  if (mailbox === 'trash') {
    const restorable = movable('inbox');
    if (restorable.length === 0) return [];
    return [
      {
        key: 'restore',
        actions: [
          {
            icon: ArrowCounterClockwiseIcon,
            label: 'Restore',
            act: file(restorable, restoreThread, 'Not every thread restored'),
          },
        ],
      },
    ];
  }

  // In Archive the move goes back to the inbox, and says so: `toggleArchive` would archive a
  // conversation that still has an inbox copy.
  const isArchive = mailbox === 'archive';
  const archivable = movable(isArchive ? 'inbox' : 'archive');
  const trashable = movable('trash');
  const unread = onServer.filter(thread => thread.isUnread);
  const unstarred = onServer.filter(thread => !thread.isStarred);
  const flag = (candidates: readonly ThreadState[], set: (threadId: string) => boolean) => () => {
    for (const { id } of candidates) set(id);
    onDone();
  };

  const moves: BulkAction[] = [
    ...(archivable.length > 0
      ? [
          {
            icon: ArchiveIcon,
            label: isArchive ? 'Move to inbox' : 'Archive',
            act: isArchive
              ? file(archivable, restoreThread, 'Not every thread moved to inbox')
              : file(archivable, toggleArchive, 'Not every thread archived'),
          },
        ]
      : []),
    ...(trashable.length > 0
      ? [
          {
            icon: TrashIcon,
            label: 'Delete',
            act: file(trashable, trashThread, 'Not every thread deleted'),
          },
        ]
      : []),
  ];
  const marks: BulkAction[] =
    onServer.length === 0
      ? []
      : [
          unread.length > 0
            ? { icon: EnvelopeOpenIcon, label: 'Mark as read', act: flag(unread, markRead) }
            : {
                icon: EnvelopeSimpleIcon,
                label: 'Mark as unread',
                act: () => {
                  // As the reader's own button does: left open, it would be marked read again.
                  if (openId !== undefined && onServer.some(({ id }) => id === openId)) {
                    void navigate({
                      to: '/m/$mailbox',
                      params: { mailbox },
                      search: previous => previous,
                    });
                  }
                  flag(onServer, markUnread)();
                },
              },
          unstarred.length > 0
            ? { icon: StarIcon, label: 'Star', act: flag(unstarred, toggleStar) }
            : { icon: StarIcon, isFilled: true, label: 'Unstar', act: flag(onServer, toggleStar) },
        ];
  return [
    { key: 'moves', actions: moves },
    { key: 'marks', actions: marks },
  ].filter(({ actions }) => actions.length > 0);
};

export const BulkActions = ({
  threads,
  mailbox,
  openId,
  onDone,
}: {
  threads: readonly ThreadState[];
  mailbox: MailboxId;
  openId: string | undefined;
  onDone: () => void;
}) => {
  const groups = useBulkActions(threads, mailbox, openId, onDone);

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
