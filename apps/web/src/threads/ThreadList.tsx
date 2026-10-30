import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { type ThreadState, threadByHandle } from '@yozz.app/mail/threads/thread';
import {
  isViewId,
  type MailboxId,
  olderAvailable,
  syncProgressIn,
} from '@yozz.app/mail/threads/views';
import { cn } from 'cn';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { useMail } from '../store/MailProvider';
import { buttonClass } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { BulkActions } from './BulkActions';
import { useSelection } from './selection';
import { ThreadRow } from './ThreadRow';

/** The list over a mailbox: search, the rows, the empty states and Older mail. */

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

/**
 * Only the rows in view, and a few either side, are in the DOM, so a mailbox of thousands renders
 * like one of thirty. Each row is measured: below `lg` a record folds to two lines.
 */
const ThreadRows = ({
  threads,
  mailbox,
  openId,
  selection,
}: {
  threads: readonly ThreadState[];
  mailbox: MailboxId;
  openId: string | undefined;
  selection: ReturnType<typeof useSelection>;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row holding focus stays mounted when it scrolls away, or focus would fall to the page.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = threads.findIndex(thread => thread.id === focusedId);
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
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
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
                mailbox={mailbox}
                isSelected={thread.id === openId}
                isChecked={selection.isChecked(thread.id)}
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
  // Which row is open is a fact about the URL, so the row link and its inversion cannot disagree.
  // Resolved the way `ThreadPage` resolves it: a message id in the URL names its conversation.
  const { _splat: handle } = useParams({ strict: false });
  const openId = handle === undefined ? undefined : threadByHandle(threads, handle)?.id;
  const { accounts, recordsError, syncStates, sync, loadOlder, isLoadingOlder, isDemo } = useMail();
  // Opening a message, another mailbox or another search each start a new selection.
  const selection = useSelection(
    threads.map(({ id }) => id),
    [mailbox, query, handle ?? ''].join('\n'),
  );
  const checked = threads.filter(({ id }) => selection.isChecked(id));

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
    if (accounts.length === 0) {
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
      {/* One bar, two jobs: search, or what to do with the ticked rows. Above `lg` its box sits
          over the rows' boxes and its magnifier over their stars; below `lg` the box appears only
          while selecting, and Select stands apart from the search behind a rule. */}
      <div className="flex h-11 shrink-0 items-center border-b border-rule-soft pl-1">
        <Checkbox
          checked={selection.isAllChecked}
          indeterminate={checked.length > 0 && !selection.isAllChecked}
          onCheckedChange={() => selection.toggleAll()}
          label={checked.length > 0 ? 'Clear the selection' : 'Select every message'}
          className={cn('h-full w-11 lg:flex lg:w-7.5', !selection.isSelecting && 'hidden')}
        />
        {selection.isSelecting ? (
          <div className="flex min-w-0 flex-1 items-center lg:pl-1">
            <BulkActions
              threads={checked}
              mailbox={mailbox}
              openId={openId}
              onDone={selection.clear}
            />
          </div>
        ) : (
          <>
            <span className="flex h-full w-11 shrink-0 items-center justify-center lg:w-7.5">
              <MagnifyingGlassIcon size={14} className="text-paper-faint" />
            </span>
            <input
              type="search"
              // Named: an unnamed field trips Chrome's autofill advisory, and here remembering is wanted.
              name="search"
              value={query}
              onChange={event => onQueryChange(event.target.value)}
              placeholder="Search sender, subject or address"
              aria-label="Search mail"
              className="h-full w-full min-w-0 bg-transparent pr-3 pl-2 text-base text-paper outline-none placeholder:text-paper-faint lg:pl-0"
            />
          </>
        )}
        {/* Cancel stays while selecting, ticked or not, and even once a sync has emptied the list:
            it clears the ticks and leaves. */}
        {(threads.length > 0 || selection.isSelecting) && (
          <button
            type="button"
            onClick={() => selection.setSelecting(!selection.isSelecting)}
            className="ml-auto h-full shrink-0 border-l border-rule-soft px-4 text-base text-paper-dim -outline-offset-2 hover:bg-ink-hover hover:text-paper lg:hidden"
          >
            {selection.isSelecting ? 'Cancel' : 'Select'}
          </button>
        )}
      </div>

      {threads.length === 0 ? (
        empty
      ) : (
        <ThreadRows threads={threads} mailbox={mailbox} openId={openId} selection={selection} />
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
