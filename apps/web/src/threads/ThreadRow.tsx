import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  type Icon,
  MailboxIcon,
  PaperclipIcon,
  StarIcon,
  TrashIcon,
  WarningOctagonIcon,
} from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { movesOffered } from '@yozz.app/mail/threads/reconcile';
import type { Message, ThreadState } from '@yozz.app/mail/threads/thread';
import { attachmentsOf, inboxesOf, isOnServer, newestInbound } from '@yozz.app/mail/threads/thread';
import { isNamedView, latestOf, previewOf, type ViewId } from '@yozz.app/mail/threads/views';
import { cn } from 'cn';
import type { ButtonHTMLAttributes } from 'react';
import { DISCARD_WARNING } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Checkbox } from '../ui/Checkbox';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { reportProblem } from '../ui/Toast';
import { Tooltip } from '../ui/Tooltip';
import { listTime } from '../ui/time';
import { discardableDraftIds, discardDrafts, discardTitle } from './discard-drafts';
import { JUNK_COPY } from './junk-copy';
import { useAdvancePast } from './use-advance';

/** One record in columns: a 34px line above `lg`, two lines below. Contrast figures and rationale are in DESIGN.md. */

/**
 * The row's triage is revealed while the pointer is on the row, while anything in it has keyboard
 * focus, and while one of its confirm sheets is up — or the trigger would vanish under its own
 * dialog (Base UI's trigger sets `aria-expanded`, not `data-popup-open`). Hover variants only
 * apply on a device that hovers, so a tap never lands on a mark that has only just appeared.
 */
const REVEALED = {
  /** The cluster: out of sight and out of reach, yet in the tab order, until revealed. */
  shown:
    'pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-has-[:focus-visible]:pointer-events-auto group-has-[:focus-visible]:opacity-100 group-has-[[aria-expanded=true]]:pointer-events-auto group-has-[[aria-expanded=true]]:opacity-100',
  /** The time, which gives its place to the cluster but keeps its room, so nothing beside it moves. */
  gone: 'lg:group-hover:opacity-0 lg:group-has-[:focus-visible]:opacity-0 lg:group-has-[[aria-expanded=true]]:opacity-0',
};

/** The room the cluster of three marks takes, which the time's cell keeps beside an address. */
const TRIAGE_CELL = 'lg:min-w-21';

export type RowProps = { thread: ThreadState; view: ViewId; isSelected: boolean };

/**
 * Derived in one place so the row and its link's accessible name cannot disagree. `latest` decides
 * where the thread sits and its time; `inbound` decides everything the row says about
 * correspondence (on a thread you replied to, `latest` is your own reply).
 */
const useRecord = (thread: ThreadState, view: ViewId) => {
  const { ownedAddresses, mailboxes } = useMail();
  const latest = latestOf(thread);
  const inbound = inboundOf(thread, ownedAddresses);
  // Sent and Drafts list what you wrote, so the other party is who it is to.
  const outbound = (() => {
    if (view === 'drafts') return thread.messages.findLast(message => message.isDraft === true);
    if (view !== 'sent') return undefined;
    return thread.messages.findLast(
      message => message.isDraft !== true && ownedAddresses.includes(message.fromAddress),
    );
  })();
  return {
    latest,
    inbound,
    who: outbound === undefined ? inbound.fromName : `To: ${recipientsOf(outbound)}`,
    receivedAt: receivedAtOf(thread, view, ownedAddresses, mailboxes),
    attachments: attachmentsOf(thread),
  };
};

/** The message the row speaks for: the newest one that came in, else the newest there is. */
const inboundOf = (thread: ThreadState, ownedAddresses: readonly string[]) =>
  newestInbound(thread, ownedAddresses) ?? latestOf(thread);

/**
 * Which of your addresses a thread came to, as the row writes it. An address's own view says where
 * the mail came to already, and so does having one address: then null.
 */
const receivedAtOf = (
  thread: ThreadState,
  view: ViewId,
  ownedAddresses: readonly string[],
  mailboxes: readonly { readonly address: string }[],
): string | null => {
  if (!isNamedView(view) || mailboxes.length <= 1) return null;
  const [receivedAt, ...alsoAt] = [
    ...inboxesOf(inboundOf(thread, ownedAddresses)),
    ...thread.mailboxes,
  ].filter((address, index, all) => all.indexOf(address) === index);
  if (receivedAt === undefined) return null;
  return `${shortAddress(receivedAt, mailboxes)}${alsoAt.length > 0 ? ` +${alsoAt.length}` : ''}`;
};

/** The widest the address cell gets: past it the address is cut, and the subject keeps its room. */
const ADDRESS_CELL_MAX_CH = 10;

/**
 * The address cell's width in characters, the same for every row so the cells line up: as wide as
 * the longest address the list shows, to a cap. Nought where no row shows one.
 */
export const addressCellWidth = (
  threads: readonly ThreadState[],
  view: ViewId,
  ownedAddresses: readonly string[],
  mailboxes: readonly { readonly address: string }[],
): number => {
  let widest = 0;
  for (const thread of threads) {
    widest = Math.max(widest, receivedAtOf(thread, view, ownedAddresses, mailboxes)?.length ?? 0);
    if (widest >= ADDRESS_CELL_MAX_CH) return ADDRESS_CELL_MAX_CH;
  }
  return widest;
};

/** Who a message you wrote is to. A draft holds the To line as typed, and may hold none yet. */
const recipientsOf = ({ to, toAddress }: Message) => {
  if (to !== undefined && to.length > 0) {
    return to.map(({ name, address }) => name ?? address).join(', ');
  }
  return toAddress.trim() === '' ? 'no one yet' : toAddress;
};

/** The parts of an address that might tell it from the others, shortest first. */
const ADDRESS_PARTS: readonly ((address: string) => string)[] = [
  address => address.slice(address.lastIndexOf('@') + 1).split('.')[0] ?? address,
  address => address.slice(0, address.lastIndexOf('@')),
  address => address,
];

/**
 * An address in the fewest characters that still tell it from the other connected addresses: the
 * first label of its domain (`northlane`), else its local part, else the whole address.
 */
const shortAddress = (address: string, mailboxes: readonly { readonly address: string }[]) => {
  const partOf =
    ADDRESS_PARTS.find(
      part => new Set(mailboxes.map(mailbox => part(mailbox.address))).size === mailboxes.length,
    ) ?? (whole => whole);
  return partOf(address);
};

/**
 * One link covers the row and carries the whole record as its accessible name; the visible spans
 * are decorative. It stays the current one while the open row's bar gives way to ticked rows.
 */
const RowLink = ({ thread, view, isSelected, isBarred }: RowProps & { isBarred: boolean }) => {
  const { latest, inbound, who, attachments } = useRecord(thread, view);

  return (
    <Link
      to="/m/$view/t/$"
      params={{ view, _splat: thread.id }}
      // Spread rather than replace: opening a message must not clear the search that found it.
      search={previous => previous}
      aria-current={isSelected ? true : undefined}
      // The ring is drawn inside the row; on the inverted bar a --signal outline sits on --select at 1.5:1.
      className={cn('absolute inset-0 -outline-offset-2', isBarred && 'focus-visible:outline-ink')}
      aria-label={[
        thread.isUnread ? 'Unread.' : null,
        `${who}: ${thread.subject}.`,
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
}: Omit<RowProps, 'view'> & { className: string }) => {
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
  /** What it does, for the tooltip. */
  readonly name: string;
  /** What it does to which thread, for the accessible name. */
  readonly label: string;
  readonly act: () => unknown;
  readonly confirm?: {
    readonly title: string;
    readonly description: string;
    readonly confirmLabel: string;
    readonly busyLabel: string;
  };
};

/**
 * Archive, Junk and delete for server messages; undo in Trash and Junk; discard in Drafts or for
 * drafts alone; nothing otherwise.
 */
const useRowActions = ({ thread, view, isSelected }: RowProps): readonly RowAction[] => {
  const {
    toggleArchive,
    trashThread,
    restoreThread,
    moveThreadsWithUndo,
    junkFolders,
    removeDraft,
  } = useMail();
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
  const draftIds = discardableDraftIds([thread], view);
  return (() => {
    if (draftIds.length > 0) {
      return [
        {
          icon: TrashIcon,
          name: 'Discard',
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
    const { canRestore, canArchive, canMoveToInbox, canMoveToJunk, canMoveOutOfJunk, canDelete } =
      movesOffered(thread, junkFolders);
    return [
      ...(canRestore
        ? [
            {
              icon: ArrowCounterClockwiseIcon,
              name: 'Restore',
              label: `Restore ${thread.subject}`,
              act: file(restoreThread, 'Thread not restored'),
            },
          ]
        : []),
      ...(canArchive
        ? [
            {
              icon: ArchiveIcon,
              name: 'Archive',
              label: `Archive ${thread.subject}`,
              act: file(toggleArchive, 'Thread not archived'),
            },
          ]
        : []),
      ...(canMoveToInbox
        ? [
            {
              icon: MailboxIcon,
              name: 'Move to inbox',
              label: `Move ${thread.subject} to inbox`,
              act: file(toggleArchive, 'Thread not moved to inbox'),
            },
          ]
        : []),
      ...(canMoveToJunk
        ? [
            {
              icon: WarningOctagonIcon,
              name: JUNK_COPY.moveToJunk,
              label: `${JUNK_COPY.moveToJunk}: ${thread.subject}`,
              act: file(
                (threadId, onRefused) =>
                  moveThreadsWithUndo([threadId], 'junk', onRefused).has(threadId),
                JUNK_COPY.notMovedToJunk,
              ),
            },
          ]
        : []),
      ...(canMoveOutOfJunk
        ? [
            {
              icon: MailboxIcon,
              name: 'Move to inbox',
              label: `Move ${thread.subject} to inbox`,
              act: file(restoreThread, 'Thread not moved to inbox'),
            },
          ]
        : []),
      ...(canDelete
        ? [
            {
              icon: TrashIcon,
              name: 'Delete',
              label: `Delete ${thread.subject}`,
              act: file(trashThread, 'Thread not deleted'),
            },
          ]
        : []),
    ];
  })();
};

/**
 * One mark of the cluster, as tall as the row so a near miss does not open the message. It spreads
 * what it is given: a confirm sheet's trigger and the tooltip both hand it their props.
 */
const TriageMark = ({
  icon: Mark,
  name,
  isSelected,
  ...props
}: { icon: Icon; name: string; isSelected: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <Tooltip label={name}>
    <button
      type="button"
      className={cn(
        'flex h-8.5 w-7 items-center justify-center -outline-offset-2',
        isSelected
          ? 'text-ink/60 hover:text-ink focus-visible:outline-ink'
          : 'text-paper-faint hover:text-paper',
      )}
      {...props}
    >
      <Mark size={13} />
    </button>
  </Tooltip>
);

/**
 * Desktop only: on touch, the reader carries triage. An overlay on the row's right edge, over the
 * time's cell, on the row's own ground so whatever it covers is covered; the cells under it never
 * move.
 */
const RowTriage = ({
  actions,
  isSelected,
  ground,
}: {
  actions: readonly RowAction[];
  isSelected: boolean;
  ground: string;
}) =>
  actions.length === 0 ? null : (
    <span
      className={cn(
        'absolute inset-y-0 right-2 z-10 hidden items-center justify-end lg:flex',
        actions.length > 2 ? 'w-21' : 'w-14',
        ground,
        REVEALED.shown,
      )}
    >
      {actions.map(({ icon, name, label, act, confirm }) =>
        confirm === undefined ? (
          <TriageMark
            key={label}
            icon={icon}
            name={name}
            isSelected={isSelected}
            aria-label={label}
            onClick={() => void act()}
          />
        ) : (
          <ConfirmDialog
            key={label}
            trigger={
              <TriageMark icon={icon} name={name} isSelected={isSelected} aria-label={label} />
            }
            {...confirm}
            onConfirm={async () => void (await act())}
          />
        ),
      )}
    </span>
  );

/** Whether the row is ticked, and how it says so; see `selection.ts`. */
type CheckProps = {
  isChecked: boolean;
  /** Whether any row in the list is ticked: then, as in Gmail, the open row gives up its bar. */
  hasSelection: boolean;
  /** How wide, in characters, the cell for the address it came to is: see `addressCellWidth`. */
  addressWidth: number;
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
  view,
  isSelected,
  isChecked,
  addressWidth,
  hasSelection,
  isSelecting,
  onCheck,
}: RowProps & CheckProps) => {
  const isBarred = isSelected && !hasSelection;
  const isUnread = thread.isUnread;
  const { latest, who, receivedAt, attachments } = useRecord(thread, view);
  const actions = useRowActions({ thread, view, isSelected });
  // The row's ground in each state, which the triage cluster repeats over the time.
  const ground = (() => {
    if (isBarred) return 'bg-select';
    if (isChecked) return 'bg-signal-wash';
    return isUnread ? 'bg-ink-raised' : 'bg-ink';
  })();

  return (
    <div
      className={cn(
        'group relative grid items-center gap-x-2 py-2 pr-2 pl-1 text-base',
        'grid-cols-[2.75rem_minmax(0,1fr)_auto_2.75rem]',
        'lg:h-8.5 lg:grid-cols-[1.875rem_1.875rem_8.25rem_minmax(0,1fr)_auto_auto] lg:gap-x-0 lg:py-0',
        isBarred && 'text-ink',
        ground,
      )}
    >
      <RowLink thread={thread} view={view} isSelected={isSelected} isBarred={isBarred} />

      {/* The row's left edge carries two marks that never read as each other. The pointer's is a
          full-height hairline, and no ground: beside unread's raised ground a hover ground read as
          a second state. Unread's is a square on the same edge, over the hairline, since weight
          and a ground one step up are too faint to carry it alone. Open and ticked are grounds. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-0.5 opacity-0 group-hover:opacity-100',
          isBarred ? 'bg-ink' : 'bg-paper-faint',
        )}
      />
      {isUnread && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1/2 left-0 size-1.5 -translate-y-1/2',
            isBarred ? 'bg-signal-deep' : 'bg-signal',
          )}
        />
      )}

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
        {who}
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
          the time. As in Gmail, the triage is laid over the time while the actions are out, and the
          time keeps its room, so nothing in the row moves. A row with nothing to do keeps its time. */}
      {(attachments.length > 0 || receivedAt !== null) && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none col-start-3 row-start-1 flex items-center gap-1.5 lg:col-start-5 lg:mr-1.5',
            isBarred ? 'text-ink/60' : 'text-paper-faint',
          )}
        >
          {attachments.length > 0 && (
            <span className="flex w-4 justify-center">
              <PaperclipIcon size={12} />
            </span>
          )}
          {/* Which of your addresses it came to: one width for the list, so the cells line up down it. */}
          {receivedAt !== null && (
            <span style={{ width: `${addressWidth}ch` }} className="truncate font-mono text-2xs">
              {receivedAt}
            </span>
          )}
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
          // The room the triage takes where an address sits beside it (the cluster would cover the
          // tag), and for any date the list writes, so those cells share an edge all down the list.
          receivedAt !== null && TRIAGE_CELL,
          receivedAt !== null && 'lg:pl-2',
        )}
      >
        {listTime(latest.at)}
      </span>

      <RowTriage actions={actions} isSelected={isBarred} ground={ground} />
    </div>
  );
};
