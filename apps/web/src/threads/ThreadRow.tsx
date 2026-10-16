import { cn } from '@fishballapps/cn';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  type Icon,
  PaperclipIcon,
  StarIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { DISCARD_WARNING } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Checkbox } from '../ui/Checkbox';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { reportProblem } from '../ui/Toast';
import { listTime } from '../ui/time';
import { discardDrafts, discardTitle, draftIdsOf } from './discard-drafts';
import { canMoveTo } from './reconcile';
import type { ThreadState } from './thread';
import { attachmentsOf, isArchived, isOnServer, newestInbound } from './thread';
import { useAdvancePast } from './use-advance';
import { latestOf, type MailboxId, previewOf } from './views';

/** One record in columns: a 34px line above `lg`, two lines below. Contrast figures and rationale are in DESIGN.md. */

/**
 * The row's triage is revealed while the pointer is on the row, while anything in it has keyboard
 * focus, and while one of its confirm sheets is up — or the trigger would vanish under its own
 * dialog (Base UI's trigger sets `aria-expanded`, not `data-popup-open`).
 */
const REVEALED = {
  shown:
    'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[aria-expanded=true]]:opacity-100',
  /** The time, which gives its place to the triage. */
  gone: 'lg:group-hover:hidden lg:group-has-[:focus-visible]:hidden lg:group-has-[[aria-expanded=true]]:hidden',
  /** The triage: no width until revealed, yet still in the tab order. */
  opened:
    'w-0 overflow-hidden group-hover:w-12 group-has-[:focus-visible]:w-12 group-has-[[aria-expanded=true]]:w-12',
};

export type RowProps = { thread: ThreadState; mailbox: MailboxId; isSelected: boolean };

/**
 * Derived in one place so the row and its link's accessible name cannot disagree. `latest` decides
 * where the thread sits and its time; `inbound` decides everything the row says about
 * correspondence (on a thread you replied to, `latest` is your own reply).
 */
const useRecord = (thread: ThreadState) => {
  const { ownedAddresses } = useMail();
  const latest = latestOf(thread);
  return {
    latest,
    inbound: newestInbound(thread, ownedAddresses) ?? latest,
    attachments: attachmentsOf(thread),
  };
};

/**
 * One link covers the row and carries the whole record as its accessible name; the visible spans
 * are decorative. It stays the current one while the open row's bar gives way to ticked rows.
 */
const RowLink = ({ thread, mailbox, isSelected, isBarred }: RowProps & { isBarred: boolean }) => {
  const { latest, inbound, attachments } = useRecord(thread);

  return (
    <Link
      to="/m/$mailbox/t/$"
      params={{ mailbox, _splat: thread.id }}
      // Spread rather than replace: opening a message must not clear the search that found it.
      search={previous => previous}
      aria-current={isSelected ? true : undefined}
      // The ring is drawn inside the row; on the inverted bar a --signal outline sits on --select at 1.5:1.
      className={cn('absolute inset-0 -outline-offset-2', isBarred && 'focus-visible:outline-ink')}
      aria-label={[
        thread.isUnread ? 'Unread.' : null,
        `${inbound.fromName}: ${thread.subject}.`,
        previewOf(thread),
        `Delivered to ${inbound.toAddress}.`,
        listTime(latest.at),
        attachments.length > 0 ? `${attachments.length} attachments.` : null,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
};

const StarButton = ({
  thread,
  isSelected,
  className,
}: Omit<RowProps, 'mailbox'> & { className: string }) => {
  const { toggleStar } = useMail();
  if (!isOnServer(thread)) return null;

  // On --select the star steps to --signal-deep (same hue at 3.37:1); an --ink star there reads as off.
  const tone = (() => {
    if (thread.isStarred) return isSelected ? 'text-signal-deep' : 'text-signal';
    return isSelected ? 'text-ink/50 hover:text-ink' : 'text-paper-faint hover:text-paper';
  })();

  return (
    <button
      type="button"
      onClick={() => toggleStar(thread.id)}
      className={cn(
        'relative z-10 flex items-center justify-center -outline-offset-2',
        className,
        isSelected && 'focus-visible:outline-ink',
        tone,
      )}
      aria-label={`Star ${thread.subject}`}
      aria-pressed={thread.isStarred}
    >
      {/* A star's mass sits below the middle of its box, so centred on a line it reads low beside the
          capitals; a pixel up puts it level with them. */}
      <StarIcon
        size={13}
        weight={thread.isStarred ? 'fill' : 'regular'}
        className="-translate-y-px"
      />
    </button>
  );
};

/** One mark in the hover cluster. `confirm` present means it asks before it acts. */
type RowAction = {
  readonly icon: Icon;
  readonly label: string;
  readonly act: () => unknown;
  readonly confirm?: {
    readonly title: string;
    readonly description: string;
    readonly confirmLabel: string;
    readonly busyLabel: string;
  };
};

/** Archive and delete for server messages; undo in Trash; discard in Drafts; nothing otherwise. */
const useRowActions = ({ thread, mailbox, isSelected }: RowProps): readonly RowAction[] => {
  const { toggleArchive, trashThread, restoreThread, removeDraft } = useMail();
  const advancePast = useAdvancePast();
  // Filing the open thread from its row moves the reader on, as the reader's own buttons do; a
  // move the store refused moves nothing and says why, now or when the server answers.
  const file =
    (move: (threadId: string, onRefused: (reason: string) => void) => boolean, notFiled: string) =>
    () => {
      if (move(thread.id, reason => reportProblem(notFiled, reason)) && isSelected) {
        advancePast(thread.id);
      }
    };
  // A draft has no IMAP copy, so archive and delete can do nothing to it.
  const draftIds = draftIdsOf([thread]);
  return (() => {
    if (mailbox === 'drafts' && draftIds.length > 0) {
      return [
        {
          icon: TrashIcon,
          label: `Discard ${thread.subject}`,
          // The same sheet the composer's Discard takes.
          confirm: {
            title: discardTitle(draftIds.length),
            description: DISCARD_WARNING,
            confirmLabel: 'Discard',
            busyLabel: 'Discarding…',
          },
          act: () => discardDrafts(removeDraft, draftIds),
        },
      ];
    }
    // A just-sent message or vault-held sent mail alone: no server holds a copy to file.
    if (!isOnServer(thread)) return [];
    if (mailbox === 'trash') {
      if (!canMoveTo(thread.folders, 'inbox')) return [];
      return [
        {
          icon: ArrowCounterClockwiseIcon,
          label: `Restore ${thread.subject}`,
          act: file(restoreThread, 'Thread not restored'),
        },
      ];
    }
    const archiveTarget = isArchived(thread) ? 'inbox' : 'archive';
    return [
      ...(canMoveTo(thread.folders, archiveTarget)
        ? [
            {
              icon: ArchiveIcon,
              label: isArchived(thread)
                ? `Move ${thread.subject} to inbox`
                : `Archive ${thread.subject}`,
              act: file(
                toggleArchive,
                isArchived(thread) ? 'Thread not moved to inbox' : 'Thread not archived',
              ),
            },
          ]
        : []),
      ...(canMoveTo(thread.folders, 'trash')
        ? [
            {
              icon: TrashIcon,
              label: `Delete ${thread.subject}`,
              act: file(trashThread, 'Thread not deleted'),
            },
          ]
        : []),
    ];
  })();
};

/** Desktop only: on touch, the reader carries triage. */
const RowTriage = ({
  actions,
  isSelected,
  className,
}: {
  actions: readonly RowAction[];
  isSelected: boolean;
  className: string;
}) =>
  actions.length === 0 ? null : (
    <span className={cn('relative z-10 hidden items-center justify-end lg:flex', className)}>
      {actions.map(({ icon: Mark, label, act, confirm }) => {
        const mark = (
          <button
            type="button"
            {...(confirm === undefined ? { onClick: () => void act() } : {})}
            className={cn(
              'flex w-6 justify-center -outline-offset-2 opacity-0 transition-opacity',
              REVEALED.shown,
              isSelected
                ? 'text-ink/60 hover:text-ink focus-visible:outline-ink'
                : 'text-paper-faint hover:text-paper',
            )}
            aria-label={label}
          >
            <Mark size={13} />
          </button>
        );
        return confirm === undefined ? (
          <span key={label}>{mark}</span>
        ) : (
          <ConfirmDialog
            key={label}
            trigger={mark}
            {...confirm}
            onConfirm={async () => void (await act())}
          />
        );
      })}
    </span>
  );

/** Whether the row is ticked, and how it says so; see `selection.ts`. */
type CheckProps = {
  isChecked: boolean;
  /** Whether any row in the list is ticked: then, as in Gmail, the open row gives up its bar. */
  hasSelection: boolean;
  /** Below `lg`, the Select button's mode: the box takes the star's cell and a tap ticks the row. */
  isSelecting: boolean;
  onCheck: (isChecked: boolean, extend: boolean) => void;
};

/**
 * One grid, two shapes. Below `lg` the record folds onto two lines rather than truncating every
 * subject, and the star spans both lines so its 44px touch target is a real cell. Above `lg` a box
 * leads every row, as in Gmail; below it the box replaces the star only while selecting.
 */
export const ThreadRow = ({
  thread,
  mailbox,
  isSelected,
  isChecked,
  hasSelection,
  isSelecting,
  onCheck,
}: RowProps & CheckProps) => {
  const isBarred = isSelected && !hasSelection;
  const isUnread = thread.isUnread;
  const { latest, inbound, attachments } = useRecord(thread);
  const actions = useRowActions({ thread, mailbox, isSelected });

  return (
    <div
      className={cn(
        'group relative grid items-center gap-x-2 py-2 pr-2 pl-1 text-base',
        'grid-cols-[2.75rem_minmax(0,1fr)_auto_2.75rem]',
        'lg:h-8.5 lg:grid-cols-[1.875rem_1.875rem_9.375rem_minmax(0,1fr)_auto_auto_auto] lg:gap-x-0 lg:py-0',
        (() => {
          if (isBarred) return 'bg-select text-ink';
          if (isChecked) return 'bg-signal-wash';
          // No hover ground, as in Gmail: beside unread's raised ground it read as a second state.
          return isUnread && 'bg-ink-raised';
        })(),
      )}
    >
      <RowLink thread={thread} mailbox={mailbox} isSelected={isSelected} isBarred={isBarred} />

      {/* While selecting, a tap anywhere on a phone's row ticks it rather than opening it. The box
          is the control a keyboard or screen reader uses; this only widens its target. */}
      {isSelecting && (
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={() => onCheck(!isChecked, false)}
          className="absolute inset-0 z-20 lg:hidden"
        />
      )}

      <Checkbox
        checked={isChecked}
        onCheckedChange={onCheck}
        label={`Select ${thread.subject}`}
        isOnSelect={isBarred}
        className={cn(
          'col-start-1 row-span-2 row-start-1 size-11 lg:row-span-1 lg:flex lg:h-8.5 lg:w-full',
          isSelecting ? 'z-30' : 'hidden',
        )}
      />

      <StarButton
        thread={thread}
        isSelected={isBarred}
        className={cn(
          'col-start-1 row-span-2 row-start-1 size-11 lg:col-start-2 lg:row-span-1 lg:h-6 lg:w-full',
          isSelecting && 'hidden lg:flex',
        )}
      />

      <span
        dir="auto"
        aria-hidden
        className={cn(
          'pointer-events-none col-start-2 row-start-1 truncate lg:col-start-3 lg:pr-3',
          isUnread && !isBarred && 'font-semibold text-paper',
          !isUnread && !isBarred && 'text-paper-dim',
          isBarred && 'font-medium',
        )}
      >
        {inbound.fromName}
      </span>

      <span
        aria-hidden
        className="pointer-events-none col-start-2 col-end-5 row-start-2 min-w-0 truncate lg:col-start-4 lg:col-end-5 lg:row-start-1 lg:pr-3"
      >
        <span
          dir="auto"
          className={cn(
            isUnread && !isBarred && 'font-semibold text-paper',
            !isUnread && !isBarred && 'text-paper-dim',
          )}
        >
          {thread.subject}
        </span>
        {thread.messages.length > 1 && (
          <span
            className={cn(
              'ml-1.5 font-mono text-2xs',
              isBarred ? 'text-ink/60' : 'text-paper-faint',
            )}
          >
            {thread.messages.length}
          </span>
        )}
        <span dir="auto" className={cn('ml-2', isBarred ? 'text-ink/60' : 'text-paper-faint')}>
          {previewOf(thread)}
        </span>
      </span>

      {/* Everything right of the subject is as wide as what it holds, so the subject runs up to
          the time. As in Gmail, the time gives its place to the triage while the actions are out,
          and the subject gives up only the difference. A row with nothing to do keeps its time. */}
      {attachments.length > 0 && (
        <span
          aria-hidden
          className="pointer-events-none col-start-3 row-start-1 flex w-4 justify-center lg:col-start-5 lg:mr-1.5"
        >
          <PaperclipIcon size={12} className={isBarred ? 'text-ink/60' : 'text-paper-faint'} />
        </span>
      )}

      <span
        aria-hidden
        className={cn(
          'pointer-events-none col-start-4 row-start-1 text-right font-mono text-2xs lg:col-start-6',
          (() => {
            if (isBarred) return 'text-ink/60';
            return isUnread ? 'font-semibold text-paper' : 'text-paper-faint';
          })(),
          actions.length > 0 && REVEALED.gone,
        )}
      >
        {listTime(latest.at)}
      </span>

      <RowTriage
        actions={actions}
        isSelected={isBarred}
        className={cn('col-start-7 row-start-1', REVEALED.opened)}
      />
    </div>
  );
};
