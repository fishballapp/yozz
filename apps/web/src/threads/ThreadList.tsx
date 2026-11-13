import { Link, useParams } from '@tanstack/react-router';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { parseQuery } from '@yozz.app/mail/threads/query';
import { type ThreadState, threadByHandle } from '@yozz.app/mail/threads/thread';
import {
  isNamedView,
  type Listing,
  olderAvailable,
  syncProgressIn,
  type ViewId,
} from '@yozz.app/mail/threads/views';
import { cn } from 'cn';
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { useMail } from '../store/MailProvider';
import { buttonClass, linkClass } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { useMediaQuery } from '../ui/chrome';
import { BulkActions } from './BulkActions';
import { SearchRow } from './SearchRow';
import { useSelection } from './selection';
import { addressCellWidth, ThreadRow } from './ThreadRow';

/** The list over a view: search, the rows, the empty states and Older mail. */

const EmptyState = ({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
    <p className="label-rule">{title}</p>
    {body !== undefined && (
      <p className="max-w-xs text-center text-base leading-relaxed text-paper-dim">{body}</p>
    )}
    {action}
  </div>
);

type EmptyCopy = { readonly title: string; readonly body?: string };

/** What a view with no mail in it says: "nothing here" means something else in each. */
const EMPTY_VIEW = {
  unified: { title: 'Inbox zero', body: 'Nothing new.' },
  starred: { title: 'Nothing starred' },
  drafts: { title: 'No drafts', body: "Close a message without sending and it's saved here." },
  sent: { title: 'Nothing sent yet' },
  archive: { title: 'Nothing archived' },
  trash: { title: 'Trash is empty' },
  junk: { title: 'No junk' },
} as const satisfies Record<string, EmptyCopy>;

/** An address is shown as written, so it goes in the sentence and not in the capitals over it. */
const emptyCopyOf = (view: ViewId): EmptyCopy =>
  isNamedView(view)
    ? EMPTY_VIEW[view]
    : { title: 'No mail yet', body: `Nothing has arrived at ${view}.` };

/**
 * How much is in the list: above `lg` over the time column, as a mail client's range is, and below
 * it on the sender column, where a phone has no time column to spare beside Select. No unread says
 * nothing rather than zero.
 */
const ListCounts = ({
  threads,
  isAllMail,
  isSelecting,
}: {
  threads: readonly ThreadState[];
  /** A search that named no folder and no address, so the count says how far it looked. */
  isAllMail: boolean;
  isSelecting: boolean;
}) => {
  const unread = threads.filter(thread => thread.isUnread).length;
  return (
    <p
      className={cn(
        'min-w-0 flex-1 truncate font-mono text-2xs text-paper-faint lg:pr-2 lg:pl-0 lg:text-right',
        isSelecting ? 'pl-2' : 'pl-13',
      )}
    >
      {unread > 0 && <span className="text-signal">{unread} unread · </span>}
      {`${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'}${isAllMail ? ' in all mail' : ''}`}
    </p>
  );
};

const OlderMail = ({ isLoading, onLoad }: { isLoading: boolean; onLoad: () => void }) => (
  <button
    type="button"
    onClick={onLoad}
    disabled={isLoading}
    className="label-rule h-9 shrink-0 border-t border-rule-soft text-center -outline-offset-2 hover:bg-ink-hover disabled:hover:bg-transparent"
  >
    {isLoading ? 'Loading…' : 'Older mail'}
  </button>
);

/**
 * Only the rows in view, and a few either side, are in the DOM, so a view of thousands renders
 * like one of thirty. Each row is measured: below `lg` a record folds to two lines.
 */
const ThreadRows = ({
  threads,
  view,
  openId,
  selection,
}: {
  threads: readonly ThreadState[];
  view: ViewId;
  openId: string | undefined;
  selection: ReturnType<typeof useSelection>;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row holding focus stays mounted when it scrolls away, or focus would fall to the page.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = threads.findIndex(thread => thread.id === focusedId);
  const { ownedAddresses, mailboxes } = useMail();
  // The same width for every row, so the address cells line up: as wide as the longest, to a cap.
  const addressWidth = useMemo(
    () => addressCellWidth(threads, view, ownedAddresses, mailboxes),
    [threads, view, ownedAddresses, mailboxes],
  );
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    // A typical record's measured height, so the scrollbar is close to right before rows are drawn.
    estimateSize: () => 34,
    getItemKey: index => threads[index]?.id ?? index,
    overscan: 5,
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      return focusedIndex === -1 || indexes.includes(focusedIndex)
        ? indexes
        : [...indexes, focusedIndex].toSorted((a, b) => a - b);
    },
  });

  // Once per thread opened, never per change to the list under it: a sync must not scroll the list
  // away from where the reader put it.
  const showOpen = useEffectEvent((id: string | undefined) => {
    const index = threads.findIndex(thread => thread.id === id);
    if (index !== -1) virtualizer.scrollToIndex(index);
  });
  useEffect(() => showOpen(openId), [openId]);

  return (
    <div
      ref={scrollRef}
      // What "Skip to mail" moves focus to.
      id="mail"
      tabIndex={-1}
      className="min-h-0 flex-1 overflow-y-auto outline-none"
    >
      <ul
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
      >
        {virtualizer.getVirtualItems().map(({ index, key, start }) => {
          const thread = threads[index];
          if (thread === undefined) throw new Error(`No thread at row ${index}`);
          return (
            <li
              key={key}
              ref={virtualizer.measureElement}
              data-index={index}
              // Most rows are not in the DOM, so each says where it sits in the whole list.
              aria-setsize={threads.length}
              aria-posinset={index + 1}
              onFocus={() => setFocusedId(thread.id)}
              // A folded record needs a divider; at `lg` the columns do that job.
              className={cn(
                'absolute inset-x-0 top-0',
                index > 0 && 'border-t border-rule-soft lg:border-t-0',
              )}
              style={{ transform: `translateY(${start}px)` }}
            >
              <ThreadRow
                thread={thread}
                view={view}
                isSelected={thread.id === openId}
                isChecked={selection.isChecked(thread.id)}
                addressWidth={addressWidth}
                hasSelection={selection.checkedIds.length > 0}
                isSelecting={selection.isSelecting}
                onCheck={(isChecked, extend) => selection.check(thread.id, isChecked, extend)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const ThreadList = ({
  listing,
  listing: { threads, view, query, isSearch, error, older },
}: {
  listing: Listing;
}) => {
  // Which row is open is a fact about the URL, so the row link and its inversion cannot disagree.
  // Resolved the way `ThreadPage` resolves it: a message id in the URL names its conversation.
  const { _splat: handle } = useParams({ strict: false });
  const openId = handle === undefined ? undefined : threadByHandle(threads, handle)?.id;
  const {
    mailboxes,
    recordsError,
    syncStates,
    sync,
    loadOlder,
    isLoadingOlder,
    loadOlderInList,
    isLoadingOlderInList,
    isDemo,
    serverSearch,
  } = useMail();
  // Opening a message, another view or another search each start a new selection.
  const selection = useSelection(
    threads.map(({ id }) => id),
    [view, query, handle ?? ''].join('\n'),
  );
  const checked = threads.filter(({ id }) => selection.isChecked(id));
  const isWide = useMediaQuery('(min-width: 64rem)');
  // Only a search under way says fetching: nothing else is on its way, and it would hang for ever.
  const running = serverSearch?.query === query.trim() ? serverSearch : null;
  // What a typed search covers is what the box says: no `in:` is every folder but Trash and Junk,
  // no `mailbox:` every address. The count and the no-results line say so in words.
  const asked = parseQuery(query);
  const isAllMail = isSearch && asked.in.length === 0 && asked.mailboxes.length === 0;
  const isFetching = running !== null && running.phase !== 'settled';
  const emptyAnswer = (() => {
    if (isFetching) return 'Fetching…';
    return isAllMail
      ? `Nothing matches "${query}" in all mail. Trash and Junk aren't searched.`
      : `Nothing matches "${query}".`;
  })();
  // `in:` repeated is a union, so one more query reaches the two folders a search leaves out.
  const isOfferingTrashAndJunk = isAllMail && query.trim() !== '' && !isFetching;

  const empty = (() => {
    if (error !== null || (isSearch && query !== '')) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
          <p
            role="status"
            className="max-w-xs text-center text-base leading-relaxed text-paper-dim"
          >
            {error ?? emptyAnswer}
          </p>
          {error === null && isOfferingTrashAndJunk && (
            <Link
              to="/m/$view"
              params={{ view }}
              search={previous => ({ ...previous, q: `${query.trim()} in:trash in:junk` })}
              className={cn(linkClass, 'py-2')}
            >
              Search Trash and Junk
            </Link>
          )}
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
    if (!isNamedView(view)) {
      const currentMailbox = mailboxes.find(mailbox => mailbox.address === view);
      if (currentMailbox === undefined) {
        return (
          <EmptyState
            title="Not one of your addresses"
            body={`Nothing is connected at ${view}.`}
            action={
              <Link
                to="/settings/new"
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
    if (mailboxes.length === 0) {
      return (
        <EmptyState
          title="No address connected"
          body="YOZZ reads mail you already own. Connect an address and it appears here."
          action={
            <Link
              to="/settings/new"
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
      const { pending, failed } = syncProgressIn(syncStates, mailboxes, view);
      const [waitingOn] = pending;
      if (waitingOn !== undefined) {
        return (
          <EmptyState
            title="Syncing"
            body={
              pending.length === 1
                ? `Fetching the newest mail from ${waitingOn.imap.host}.`
                : `Fetching the newest mail from ${pending.length} addresses.`
            }
          />
        );
      }
      const [firstFailure] = failed;
      if (firstFailure !== undefined) {
        return (
          <EmptyState
            title="Sync failed"
            body={describeMailFailure(firstFailure.failure, firstFailure.mailbox.imap.host)}
            action={
              <button
                type="button"
                // A view is retried whole; an address, on its own.
                onClick={() => void sync(isNamedView(view) ? undefined : view)}
                className={buttonClass({ variant: 'secondary' })}
              >
                Retry
              </button>
            }
          />
        );
      }
    }
    // An empty box is no view: every folder but Trash and Junk, with nothing in any of them.
    return <EmptyState {...(isSearch ? { title: 'No mail yet' } : emptyCopyOf(view))} />;
  })();

  return (
    <div className="flex h-full flex-col">
      {/* Below `lg` the search row is the shell's top bar. */}
      {isWide && <SearchRow listing={listing} />}

      {/* The box over the rows' boxes, then what to do with the ticked ones, the first over the
          stars. Below `lg` a row has no box until you ask, and Select stands at this bar's far end
          behind a rule, as wide as Cancel so the rule holds. An empty list has nothing to select or
          count, so no row, but Cancel stays even once a sync has emptied it: it clears the ticks and
          leaves. */}
      {(threads.length > 0 || selection.isSelecting) && (
        <div className="flex h-11 shrink-0 items-center border-b border-rule-soft pl-1 lg:h-8.5">
          <Checkbox
            checked={selection.isAllChecked}
            indeterminate={checked.length > 0 && !selection.isAllChecked}
            onCheckedChange={() => selection.toggleAll()}
            label={checked.length > 0 ? 'Clear the selection' : 'Select every message'}
            className={cn('h-full w-11 lg:flex lg:w-7.5', !selection.isSelecting && 'hidden')}
          />
          {checked.length > 0 ? (
            <div className="flex min-w-0 flex-1 items-center lg:pl-px">
              <BulkActions threads={checked} view={view} openId={openId} onDone={selection.clear} />
            </div>
          ) : (
            <ListCounts
              threads={threads}
              isAllMail={isAllMail}
              isSelecting={selection.isSelecting}
            />
          )}
          <button
            type="button"
            onClick={() => selection.setSelecting(!selection.isSelecting)}
            // As wide as Cancel, so the rule holds, with the same gutter either side.
            className="ml-auto h-full w-20 shrink-0 border-l border-rule-soft px-4 text-right text-base text-paper-dim -outline-offset-2 hover:bg-ink-hover hover:text-paper lg:hidden"
          >
            {selection.isSelecting ? 'Cancel' : 'Select'}
          </button>
        </div>
      )}

      {threads.length === 0 ? (
        // What "Skip to mail" moves focus to when there are no rows to land on.
        <div id="mail" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {empty}
        </div>
      ) : (
        <ThreadRows threads={threads} view={view} openId={openId} selection={selection} />
      )}
      {/* Hidden, not disabled, once every address shown has its folder's start cached: a
          control that stays on screen implies there is more mail behind it. A query with something
          to look for searches the whole folder, so it has nothing to page. It stands under an empty
          list too: a Starred view with nothing in the newest window is exactly where older mail is
          wanted. */}
      {!isSearch && olderAvailable(syncStates, mailboxes, view) && (
        <OlderMail isLoading={isLoadingOlder(view)} onLoad={() => void loadOlder(view)} />
      )}
      {older !== null && (
        <OlderMail isLoading={isLoadingOlderInList} onLoad={() => void loadOlderInList(query)} />
      )}
    </div>
  );
};
