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
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { reportProblem } from '../ui/Toast';
import { listTime, stackTime } from '../ui/time';
import { canMoveTo } from './reconcile';
import type { ThreadState } from './thread';
import { attachmentsOf, isArchived, isOnServer, newestInbound } from './thread';
import { useAdvancePast } from './use-advance';
import { latestOf, type MailboxId, previewOf } from './views';

/**
 * Two layouts over one record, the reader's choice kept across reloads: columns (one 34px line)
 * and stacked (subject, `from → to`, three lines of body). Contrast figures and rationale are in
 * DESIGN.md.
 */

/**
 * The row's triage is revealed while the pointer is on the row, while anything in it has keyboard
 * focus, and while one of its confirm sheets is up — or the trigger would vanish under its own
 * dialog (Base UI's trigger sets `aria-expanded`, not `data-popup-open`).
 */
const REVEALED = {
  shown:
    'group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[aria-expanded=true]]:opacity-100',
  /** The column record's time, which gives its place to the triage. */
  gone: 'lg:group-hover:hidden lg:group-has-[:focus-visible]:hidden lg:group-has-[[aria-expanded=true]]:hidden',
  /** The column record's triage: no width until revealed, yet still in the tab order. */
  opened:
    'w-0 overflow-hidden group-hover:w-12 group-has-[:focus-visible]:w-12 group-has-[[aria-expanded=true]]:w-12',
};

export type RowProps = { thread: ThreadState; mailbox: MailboxId; isSelected: boolean };

/**
 * Derived in one place so the two shapes cannot disagree. `latest` decides where the thread sits
 * and its time; `inbound` decides everything the row says about correspondence (on a thread you
 * replied to, `latest` is your own reply).
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

/** One link covers the row and carries the whole record as its accessible name; the visible spans are decorative. */
const RowLink = ({ thread, mailbox, isSelected }: RowProps) => {
  const { latest, inbound, attachments } = useRecord(thread);

  return (
    <Link
      to="/m/$mailbox/t/$"
      params={{ mailbox, _splat: thread.id }}
      // Spread rather than replace: opening a message must not clear the search that found it.
      search={previous => previous}
      aria-current={isSelected ? true : undefined}
      // The ring is drawn inside the row; on the inverted bar a --signal outline sits on --select at 1.5:1.
      className={cn(
        'absolute inset-0 -outline-offset-2',
        isSelected && 'focus-visible:outline-ink',
      )}
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

/** Every way `removeDraft` can answer, minus the two that mean the draft is gone and the one nobody hears. */
type DiscardOutcome = Exclude<
  Awaited<ReturnType<ReturnType<typeof useMail>['removeDraft']>>['outcome'],
  'deleted' | 'absent' | 'ended'
>;

/** Each refusal names a different thing to do next. */
const DISCARD_REFUSALS: Record<DiscardOutcome, string> = {
  busy: 'It is open in the composer — close that first.',
  sending: 'It is being sent right now.',
  conflict: 'Another device changed it since this list was built. Reload and try again.',
  locked: 'The vault is locked.',
  offline: 'The vault could not be reached.',
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
  const draftId = thread.messages.find(message => message.isDraft === true)?.draftId;
  return (() => {
    if (mailbox === 'drafts' && draftId !== undefined) {
      return [
        {
          icon: TrashIcon,
          label: `Discard ${thread.subject}`,
          // The same sheet the composer's Discard takes.
          confirm: {
            title: 'Discard this draft?',
            description: DISCARD_WARNING,
            confirmLabel: 'Discard',
            busyLabel: 'Discarding…',
          },
          act: async () => {
            const { outcome } = await removeDraft(draftId);
            if (outcome === 'deleted' || outcome === 'absent' || outcome === 'ended') return;
            reportProblem('Draft not discarded', DISCARD_REFUSALS[outcome]);
          },
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

/**
 * One grid, two shapes. Below `lg` the record folds onto two lines rather than truncating every
 * subject, and the star spans both lines so its 44px touch target is a real cell.
 */
export const ColumnsRow = ({ thread, mailbox, isSelected }: RowProps) => {
  const isUnread = thread.isUnread;
  const { latest, inbound, attachments } = useRecord(thread);
  const actions = useRowActions({ thread, mailbox, isSelected });

  return (
    <div
      className={cn(
        'group relative grid items-center gap-x-2 py-2 pr-2 pl-1 text-base',
        'grid-cols-[2.75rem_minmax(0,1fr)_auto_2.75rem]',
        'lg:h-8.5 lg:grid-cols-[1.875rem_9.375rem_minmax(0,1fr)_auto_auto_auto] lg:gap-x-0 lg:py-0',
        isSelected ? 'bg-select text-ink' : 'hover:bg-ink-hover',
      )}
    >
      <RowLink thread={thread} mailbox={mailbox} isSelected={isSelected} />

      <StarButton
        thread={thread}
        isSelected={isSelected}
        className="col-start-1 row-span-2 row-start-1 size-11 lg:row-span-1 lg:h-6 lg:w-full"
      />

      <span
        dir="auto"
        aria-hidden
        className={cn(
          'pointer-events-none col-start-2 row-start-1 truncate lg:pr-3',
          isUnread && !isSelected && 'font-semibold text-paper',
          !isUnread && !isSelected && 'text-paper-dim',
          isSelected && 'font-medium',
        )}
      >
        {inbound.fromName}
      </span>

      <span
        aria-hidden
        className="pointer-events-none col-start-2 col-end-5 row-start-2 min-w-0 truncate lg:col-start-3 lg:col-end-4 lg:row-start-1 lg:pr-3"
      >
        <span dir="auto" className={cn(isUnread && !isSelected && 'font-medium text-paper')}>
          {thread.subject}
        </span>
        {thread.messages.length > 1 && (
          <span
            className={cn(
              'ml-1.5 font-mono text-2xs',
              isSelected ? 'text-ink/60' : 'text-paper-faint',
            )}
          >
            {thread.messages.length}
          </span>
        )}
        <span dir="auto" className={cn('ml-2', isSelected ? 'text-ink/60' : 'text-paper-faint')}>
          {previewOf(thread)}
        </span>
      </span>

      {/* Everything right of the subject is as wide as what it holds, so the subject runs up to
          the time. As in Gmail, the time gives its place to the triage while the actions are out,
          and the subject gives up only the difference. A row with nothing to do keeps its time. */}
      {attachments.length > 0 && (
        <span
          aria-hidden
          className="pointer-events-none col-start-3 row-start-1 flex w-4 justify-center lg:col-start-4 lg:mr-1.5"
        >
          <PaperclipIcon size={12} className={isSelected ? 'text-ink/60' : 'text-paper-faint'} />
        </span>
      )}

      <span
        aria-hidden
        className={cn(
          'pointer-events-none col-start-4 row-start-1 text-right font-mono text-2xs lg:col-start-5',
          isSelected ? 'text-ink/60' : 'text-paper-faint',
          actions.length > 0 && REVEALED.gone,
        )}
      >
        {listTime(latest.at)}
      </span>

      <RowTriage
        actions={actions}
        isSelected={isSelected}
        className={cn('col-start-6 row-start-1', REVEALED.opened)}
      />
    </div>
  );
};

/** Subject first and alone at the base step; `from → to` under it; three lines of body; date level with the last line. */
export const StackedRow = ({ thread, mailbox, isSelected }: RowProps) => {
  const isUnread = thread.isUnread;
  const { latest, inbound, attachments } = useRecord(thread);
  const actions = useRowActions({ thread, mailbox, isSelected });
  const dim = isSelected ? 'text-ink/60' : 'text-paper-faint';
  const senderTone = (() => {
    if (isSelected) return 'text-ink/60';
    if (isUnread) return 'text-paper';
    return 'text-paper-dim';
  })();

  return (
    <div
      className={cn(
        'group relative grid items-start gap-x-2 py-2.5 pr-3 pl-1 text-base',
        'grid-cols-[2.75rem_1.75rem_minmax(0,1fr)_auto] lg:grid-cols-[1.875rem_1.75rem_minmax(0,1fr)_auto]',
        isSelected ? 'bg-select text-ink' : 'hover:bg-ink-hover',
      )}
    >
      <RowLink thread={thread} mailbox={mailbox} isSelected={isSelected} />

      {/* The 44px touch target still spans the record, but the GLYPH is pinned to the subject line
          rather than centred in the target — a star floating beside the body text belongs to
          nothing. Above `lg` the box simply is that line. */}
      <StarButton
        thread={thread}
        isSelected={isSelected}
        className="col-start-1 row-span-3 row-start-1 size-11 items-start self-start pt-0.5 lg:h-4.5 lg:w-full lg:items-center lg:pt-0"
      />

      {/* Unread, beside the star. A square, because nothing in this system is round, and solid,
          because here it has no glyph to lean on. */}
      <span
        aria-hidden
        className="pointer-events-none col-start-2 row-start-1 flex h-4.5 items-center justify-center"
      >
        {isUnread && <span className={cn('size-1.5', isSelected ? 'bg-ink' : 'bg-signal')} />}
      </span>

      <span
        aria-hidden
        className="pointer-events-none col-start-3 row-start-1 flex min-w-0 items-baseline gap-1.5"
      >
        <span dir="auto" className={cn('truncate', isUnread ? 'font-semibold' : 'font-medium')}>
          {thread.subject}
        </span>
        {thread.messages.length > 1 && (
          <span className={cn('shrink-0 font-mono text-2xs', dim)}>{thread.messages.length}</span>
        )}
        {attachments.length > 0 && (
          <PaperclipIcon size={12} className={cn('shrink-0 self-center', dim)} />
        )}
      </span>

      {/* Sender in sans because a person's name is not a machine value; their address is, and so
          is the arrow between them. The two faces are metrically matched, which is why they can
          share a line at one size. Tight to the subject — this is its attribution, not a band of
          its own. */}
      <span
        aria-hidden
        className="pointer-events-none col-start-3 row-start-2 flex min-w-0 items-baseline gap-1.5 text-2xs"
      >
        <span dir="auto" className={cn('max-w-[50%] shrink-0 truncate', senderTone)}>
          {inbound.fromName}
        </span>
        <span className={cn('shrink-0 font-mono', dim)}>→</span>
        <span className={cn('min-w-0 truncate font-mono', dim)}>{inbound.toAddress}</span>
      </span>

      <span
        dir="auto"
        aria-hidden
        className={cn(
          'pointer-events-none col-start-3 row-start-3 mt-1.5 line-clamp-3 leading-[1.4]',
          dim,
        )}
      >
        {previewOf(thread)}
      </span>

      <RowTriage
        actions={actions}
        isSelected={isSelected}
        className="col-start-4 row-start-1 h-4.5 w-12 self-start justify-self-end"
      />

      <span
        aria-hidden
        className={cn(
          'pointer-events-none col-start-4 row-start-3 self-end text-right font-mono text-2xs',
          dim,
        )}
      >
        {stackTime(latest.at)}
      </span>
    </div>
  );
};
