import { cn } from '@fishballapps/cn';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  type Icon,
  MagnifyingGlassIcon,
  PaperclipIcon,
  RowsIcon,
  StarIcon,
  TableIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { marksOf } from '../lib/addresses';
import { useChromePref } from '../lib/chrome';
import { DISCARD_WARNING } from '../lib/compose';
import { attachmentsOf, isArchived, newestInbound } from '../lib/thread';
import { listTime, stackTime } from '../lib/time';
import {
  describeMailFailure,
  isViewId,
  latestOf,
  type MailboxId,
  olderAvailable,
  previewOf,
  syncProgressIn,
  type ThreadState,
  useMail,
} from '../state/mail';
import { buttonClass } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { IconSwitch } from './ui/IconSwitch';
import { toast } from './ui/Toast';

/**
 * TWO LAYOUTS OVER ONE RECORD. The same thread is either a COLUMN record or a STACKED record, and
 * the choice is the reader's, kept across reloads.
 *
 * - **Columns** is the scanning shape: a fixed-width 34px line whose x-positions hold down the
 *   whole list, so the eye runs vertically instead of re-finding each field per row. Address is
 *   compressed to a single gutter letter, and a header rule names the columns — which is also the
 *   only place that letter gets explained.
 * - **Stacked** is the reading shape: the subject as the focal line, a `from → to` attribution
 *   under it spelling out WHICH OF YOUR ADDRESSES the message arrived at, then three lines of the
 *   body. It costs roughly three times the height per thread and buys back both the fact the gutter
 *   letter only hints at — the one this product is organised around — and enough of the message to
 *   answer it without opening it.
 *
 * Both shapes hold their invariants: the star LEADS the row, where a Gmail user's hand already
 * goes, and keeps that position at the head of the reader too. Selection is INVERSION — a solid
 * --select bar with --ink reversed out of it; everything reversed out holds >=4.5:1 (ink/60) and
 * the unstarred star, a non-text mark, holds >=3:1 (ink/50).
 *
 * The accent buys two things in this list and nothing else: UNREAD, and STARRED. Unread takes the
 * same column in both layouts — the letter mark in columns, a solid square in stacked — so
 * switching layouts never moves it. Starred takes the star itself, which is the one place a reader
 * expects colour and the one mark they applied by hand.
 */

type Layout = 'columns' | 'stacked';

const DESKTOP_COLUMNS = 'lg:grid-cols-[1.5rem_1.75rem_9.375rem_minmax(0,1fr)_1rem_3rem_2.75rem]';

type RowProps = { thread: ThreadState; mailbox: MailboxId; isSelected: boolean };

/**
 * Everything a row reads off a thread, derived in ONE place so the two shapes cannot disagree.
 *
 * The distinction is load-bearing. `latest` decides where the thread SITS and what time it shows;
 * `inbound` decides everything the row SAYS about correspondence. Mixing them composes a routing
 * that never happened — on a thread you replied to, `latest` is your own reply, so `latest.fromName`
 * printed beside `inbound.toAddress` reads "you → your own address". Three of the fixture threads
 * did exactly that. Both ends come off `inbound`, so a row always states one real message.
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
 * are then decorative, so the row announces once instead of six times. Unread is in that name
 * because otherwise it exists only as colour and weight.
 */
const RowLink = ({ thread, mailbox, isSelected }: RowProps) => {
  const { latest, inbound, attachments } = useRecord(thread);

  return (
    <Link
      to="/m/$mailbox/t/$"
      params={{ mailbox, _splat: thread.id }}
      // Spread rather than replace: a link that states a whole search object silently drops every
      // param beside the one it cares about, and opening a message must not clear the search that
      // found it.
      search={previous => previous}
      aria-current={isSelected ? true : undefined}
      // The ring is drawn INSIDE the row, so on the inverted bar a --signal outline sits on
      // --select at 1.5:1 and disappears exactly where you are working. Invert it too.
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

  return (
    <button
      type="button"
      onClick={() => toggleStar(thread.id)}
      className={cn(
        'relative z-10 flex items-center justify-center -outline-offset-2',
        className,
        isSelected && 'focus-visible:outline-ink',
        // Starred is the accent, and it stays the accent on the inverted bar — a star that turns
        // --ink there reads as switched OFF, the one thing this mark must never do. On --select it
        // steps to --signal-deep: the same hue at 3.37:1, still C 0.177, still visibly green.
        // That one step is why the accent is this hue at all — see DECISIONS.md.
        thread.isStarred
          ? isSelected
            ? 'text-signal-deep'
            : 'text-signal'
          : isSelected
            ? 'text-ink/50 hover:text-ink'
            : 'text-paper-faint hover:text-paper',
      )}
      aria-label={`Star ${thread.subject}`}
      aria-pressed={thread.isStarred}
    >
      <StarIcon size={13} weight={thread.isStarred ? 'fill' : 'regular'} />
    </button>
  );
};

/** Every way `removeDraft` can answer, minus the two that mean the draft is gone. */
type DiscardOutcome = Exclude<
  Awaited<ReturnType<ReturnType<typeof useMail>['removeDraft']>>['outcome'],
  'deleted' | 'absent'
>;

/**
 * Why the discard did not happen, in the words the person clicking needs.
 *
 * A refusal is never "it failed": every one of these names a different thing to do next, and the
 * draft is still on screen while they read it.
 */
const discardRefusal = (outcome: DiscardOutcome) =>
  outcome === 'busy'
    ? 'It is open in the composer — close that first.'
    : outcome === 'sending'
      ? 'It is being sent right now.'
      : outcome === 'conflict'
        ? 'Another device changed it since this list was built. Reload and try again.'
        : outcome === 'locked'
          ? 'The vault is locked.'
          : 'The vault could not be reached.';

/**
 * Triage without leaving the list. With the shortcut layer gone this is the only way to clear a row
 * without opening it, so it is revealed by hover AND by keyboard focus. Archive and delete in that
 * order everywhere the row is a server message; in Trash the single mark that undoes them, and in
 * Drafts the single one that discards, because neither of the other two can touch a draft.
 */
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

const RowTriage = ({
  thread,
  mailbox,
  isSelected,
  className,
}: RowProps & { className: string }) => {
  const { toggleArchive, trashThread, restoreThread, removeDraft } = useMail();
  // A draft is a vault record with no IMAP copy, so the archive and delete below — which move
  // server messages — can do nothing to it. In Drafts the one meaningful action is discarding it.
  const draftId = thread.messages.find(message => message.isDraft === true)?.draftId;
  const actions: readonly RowAction[] =
    mailbox === 'drafts' && draftId !== undefined
      ? [
          {
            icon: TrashIcon,
            label: `Discard ${thread.subject}`,
            // The same sheet the composer's Discard takes: one action, one level of protection,
            // whichever screen it is offered from.
            confirm: {
              title: 'Discard this draft?',
              description: DISCARD_WARNING,
              confirmLabel: 'Discard',
              busyLabel: 'Discarding…',
            },
            act: async () => {
              const { outcome } = await removeDraft(draftId);
              if (outcome === 'deleted' || outcome === 'absent') return;
              toast.add({
                title: 'Draft not discarded',
                description: discardRefusal(outcome),
                timeout: 0,
                priority: 'high',
              });
            },
          },
        ]
      : mailbox === 'trash'
        ? [
            {
              icon: ArrowCounterClockwiseIcon,
              label: `Restore ${thread.subject}`,
              act: () => restoreThread(thread.id),
            },
          ]
        : [
            {
              icon: ArchiveIcon,
              label: isArchived(thread)
                ? `Move ${thread.subject} to inbox`
                : `Archive ${thread.subject}`,
              act: () => toggleArchive(thread.id),
            },
            {
              icon: TrashIcon,
              label: `Delete ${thread.subject}`,
              act: () => trashThread(thread.id),
            },
          ];

  return (
    <span className={cn('relative z-10 hidden items-center justify-end lg:flex', className)}>
      {actions.map(({ icon: Mark, label, act, confirm }) => {
        const mark = (
          <button
            type="button"
            {...(confirm === undefined ? { onClick: () => void act() } : {})}
            className={cn(
              'flex w-6 justify-center -outline-offset-2 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100',
              // A row action that opens a sheet stays visible while the sheet is up: the pointer
              // has left the row by then, and a trigger that vanishes under its own dialog is
              // what makes the sheet look like it came from nowhere. Keyed on `aria-expanded`,
              // which is what Base UI's trigger actually sets — it emits no `data-popup-open`,
              // checked in the browser rather than assumed.
              confirm === undefined ? '' : 'aria-expanded:opacity-100',
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
};

/** Above `lg` only: the two-line folded column record has no columns to head. */
const ColumnHeader = () => (
  <div
    className={cn(
      'hidden shrink-0 items-center border-b border-rule-soft py-1.5 pr-2 pl-1 lg:grid',
      DESKTOP_COLUMNS,
    )}
  >
    <span className="label-rule col-start-2">to</span>
    <span className="label-rule col-start-3">from</span>
    <span className="label-rule col-start-4">subject</span>
    <span className="label-rule col-start-7 text-right">time</span>
  </div>
);

/**
 * One grid, two shapes. Above `lg` a record is a single 34px line. Below it there is no width for
 * a 150px sender column beside a subject, so the record folds onto two lines rather than truncating
 * every subject to a dozen characters, and the star spans both lines so its 44px touch target is a
 * real cell instead of an overhang across the row link.
 */
const ColumnsRow = ({ thread, mailbox, isSelected }: RowProps) => {
  const isUnread = thread.isUnread;
  const { latest, inbound, attachments } = useRecord(thread);

  return (
    <li
      className={cn(
        'group relative grid items-center gap-x-2 py-2 pr-2 pl-1 text-base',
        'grid-cols-[2.75rem_1.75rem_minmax(0,1fr)_auto_2.75rem]',
        'lg:h-8.5 lg:gap-x-0 lg:py-0',
        DESKTOP_COLUMNS,
        isSelected ? 'bg-select text-ink' : 'hover:bg-ink-hover',
      )}
    >
      <RowLink thread={thread} mailbox={mailbox} isSelected={isSelected} />

      <StarButton
        thread={thread}
        isSelected={isSelected}
        className="col-start-1 row-span-2 row-start-1 size-11 lg:row-span-1 lg:size-6"
      />

      <span
        aria-hidden
        className={cn(
          'pointer-events-none col-start-2 row-start-1 flex justify-center font-mono text-2xs',
          isSelected ? 'text-ink/60' : isUnread ? 'text-signal' : 'text-paper-faint',
        )}
      >
        {marksOf(thread.accounts)}
      </span>

      <span
        dir="auto"
        aria-hidden
        className={cn(
          'pointer-events-none col-start-3 row-start-1 truncate lg:pr-3',
          isUnread && !isSelected && 'font-semibold text-paper',
          !isUnread && !isSelected && 'text-paper-dim',
          isSelected && 'font-medium',
        )}
      >
        {inbound.fromName}
      </span>

      <span
        aria-hidden
        className="pointer-events-none col-start-3 col-end-6 row-start-2 min-w-0 truncate lg:col-start-4 lg:col-end-5 lg:row-start-1 lg:pr-3"
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

      <span
        aria-hidden
        className="pointer-events-none col-start-4 row-start-1 flex w-4 justify-center lg:col-start-5"
      >
        {attachments.length > 0 && (
          <PaperclipIcon size={12} className={isSelected ? 'text-ink/60' : 'text-paper-faint'} />
        )}
      </span>

      <RowTriage
        thread={thread}
        mailbox={mailbox}
        isSelected={isSelected}
        className="col-start-6 row-start-1 w-12"
      />

      <span
        aria-hidden
        className={cn(
          'pointer-events-none col-start-5 row-start-1 text-right font-mono text-2xs lg:col-start-7',
          isSelected ? 'text-ink/60' : 'text-paper-faint',
        )}
      >
        {listTime(latest.at)}
      </span>
    </li>
  );
};

/**
 * Three rows, and the SUBJECT leads: it is first, alone at the base step, in full `--paper`, and
 * the only line carrying weight. Under it sits its attribution — `from → to`, the whole routing of
 * the message on one `--text-2xs` line — and under that three lines of the body. Neither can be
 * mistaken for the subject: both are a step down in size, in colour, or in both.
 *
 * The arrow does what a colon and two labels used to: a message went FROM someone TO one of your
 * addresses, and WHICH address is the fact this product is organised around. Spelling it out is the
 * entire reason this layout exists — the column record can only afford a letter for it.
 *
 * The record runs top-left to bottom-right: it opens on WHAT and closes on WHEN, level with the
 * last line of the excerpt. Triage sits at the top corner beside the star, so both controls are
 * found in one place.
 */
const StackedRow = ({ thread, mailbox, isSelected }: RowProps) => {
  const isUnread = thread.isUnread;
  const { latest, inbound, attachments } = useRecord(thread);
  const dim = isSelected ? 'text-ink/60' : 'text-paper-faint';

  return (
    <li
      className={cn(
        'group relative grid items-start gap-x-2 py-2.5 pr-3 pl-1 text-base',
        'grid-cols-[2.75rem_1.75rem_minmax(0,1fr)_auto] lg:grid-cols-[1.5rem_1.75rem_minmax(0,1fr)_auto]',
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
        className="col-start-1 row-span-3 row-start-1 size-11 items-start self-start pt-0.5 lg:h-4.5 lg:w-6 lg:items-center lg:pt-0"
      />

      {/* Unread, in the column the letter mark holds in the other layout, so switching layouts
          never moves it. A square, because nothing in this system is round, and solid, because
          here it has no glyph to lean on. */}
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
        <span
          dir="auto"
          className={cn(
            'max-w-[50%] shrink-0 truncate',
            isSelected ? 'text-ink/60' : isUnread ? 'text-paper' : 'text-paper-dim',
          )}
        >
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
        thread={thread}
        mailbox={mailbox}
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
    </li>
  );
};

const LAYOUTS = [
  { id: 'columns', Icon: TableIcon, label: 'Column layout' },
  { id: 'stacked', Icon: RowsIcon, label: 'Stacked layout' },
] as const satisfies readonly { id: Layout; Icon: Icon; label: string }[];

const EmptyState = ({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
    <p className="label-rule">{title}</p>
    <p className="max-w-xs text-center text-base leading-relaxed text-paper-dim">{body}</p>
    {action}
  </div>
);

export const ThreadList = ({
  threads,
  mailbox,
  query,
  onQueryChange,
}: {
  threads: readonly ThreadState[];
  mailbox: MailboxId;
  query: string;
  onQueryChange: (query: string) => void;
}) => {
  // Which row is open is a fact about the URL. Reading it here rather than receiving it as a prop
  // keeps the answer in one place — the row link and the row's inversion cannot disagree.
  const { _splat: threadId } = useParams({ strict: false });
  const { accounts, recordsError, syncStates, sync, loadOlder, isLoadingOlder, isDemo } = useMail();
  const [layout, setLayout] = useChromePref<Layout>('yozz:list-layout', 'columns', raw =>
    raw === 'stacked' ? 'stacked' : 'columns',
  );
  const isStacked = layout === 'stacked';
  const Row = isStacked ? StackedRow : ColumnsRow;

  const empty = (() => {
    if (query.trim() !== '') {
      return (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="max-w-xs text-center text-base leading-relaxed text-paper-dim">
            {`No mail matches “${query}”.`}
          </p>
        </div>
      );
    }
    if (recordsError !== null) {
      return (
        <div className="flex flex-1 items-center justify-center px-6">
          <p role="alert" className="max-w-xs text-center text-base leading-relaxed text-danger">
            {recordsError}
          </p>
        </div>
      );
    }
    if (!isViewId(mailbox)) {
      const currentAccount = accounts.find(account => account.address === mailbox);
      if (currentAccount === undefined) {
        return (
          <EmptyState
            title="Not one of your addresses"
            body={`Nothing is connected at ${mailbox}.`}
            action={
              <Link
                to="/connect"
                search={previous => previous}
                className={buttonClass({ variant: 'secondary' })}
              >
                Connect an address
              </Link>
            }
          />
        );
      }
    }
    if (accounts.length === 0) {
      return (
        <EmptyState
          title="No address connected"
          body="YOZZ reads mail you already own. Connect an address and it appears here."
          action={
            <Link
              to="/connect"
              search={previous => previous}
              className={buttonClass({ variant: 'primary' })}
            >
              Connect an address
            </Link>
          }
        />
      );
    }
    // Demo fixtures never sync, so an empty demo folder is empty rather than pending.
    if (!isDemo) {
      const { pending, failed } = syncProgressIn(syncStates, accounts, mailbox);
      const [waitingOn] = pending;
      if (waitingOn !== undefined) {
        return (
          <EmptyState
            title="Syncing"
            body={
              pending.length === 1
                ? `Fetching the newest mail from ${waitingOn.imap.host}.`
                : `Fetching the newest mail from ${pending.length} accounts.`
            }
          />
        );
      }
      const [firstFailure] = failed;
      if (firstFailure !== undefined) {
        return (
          <EmptyState
            title="Sync failed"
            body={describeMailFailure(firstFailure.failure, firstFailure.account.imap.host)}
            action={
              <button
                type="button"
                // A view is retried whole; an address, on its own.
                onClick={() => void sync(isViewId(mailbox) ? undefined : mailbox)}
                className={buttonClass({ variant: 'secondary' })}
              >
                Retry
              </button>
            }
          />
        );
      }
    }
    return <EmptyState title="Nothing here yet" body="No messages in this mailbox." />;
  })();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-rule-soft px-3">
        <MagnifyingGlassIcon size={14} className="shrink-0 text-paper-faint" />
        <input
          type="search"
          // Named even though nothing here submits: an unnamed field is the one thing this app
          // trips Chrome's autofill advisory on, and a search box is the one field where the
          // browser remembering what you typed is wanted rather than tolerated.
          name="search"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search sender, subject or address"
          aria-label="Search mail"
          className="h-full w-full min-w-0 bg-transparent text-base text-paper outline-none placeholder:text-paper-faint"
        />
        <div className="-mr-1">
          <IconSwitch label="List layout" options={LAYOUTS} value={layout} onChange={setLayout} />
        </div>
      </div>

      {threads.length === 0 ? (
        empty
      ) : (
        <>
          {!isStacked && <ColumnHeader />}
          {/* Stacked records have no columns to carry the structure, so they keep their dividers
              at every width; column records drop them at `lg`, where the columns do that job. */}
          <ul
            className={cn(
              'min-h-0 flex-1 divide-y divide-rule-soft overflow-y-auto',
              !isStacked && 'lg:divide-y-0',
            )}
          >
            {threads.map(thread => (
              <Row
                key={thread.id}
                thread={thread}
                mailbox={mailbox}
                isSelected={thread.id === threadId}
              />
            ))}
          </ul>
        </>
      )}
      {/* Hidden, not disabled, once every account shown has its folder's start cached: a
          control that stays on screen implies there is more mail behind it. Search reads what
          is cached, so paging under a query would answer a different question than it asks. It
          stands under an empty list too: a Starred view with nothing in the newest window is
          exactly where older mail is wanted. */}
      {query.trim() === '' && olderAvailable(syncStates, accounts, mailbox) && (
        <button
          type="button"
          onClick={() => void loadOlder(mailbox)}
          disabled={isLoadingOlder(mailbox)}
          className="label-rule h-9 shrink-0 border-t border-rule-soft text-center -outline-offset-2 hover:bg-ink-hover disabled:hover:bg-transparent"
        >
          {isLoadingOlder(mailbox) ? 'Loading…' : 'Older mail'}
        </button>
      )}
    </div>
  );
};
