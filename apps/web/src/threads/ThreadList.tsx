import { cn } from '@fishballapps/cn';
import { type Icon, MagnifyingGlassIcon, RowsIcon, TableIcon } from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from 'react';
import { describeMailFailure } from '../relay/describe-failure';
import { useMail } from '../store/MailProvider';
import { buttonClass } from '../ui/Button';
import { useChromePref } from '../ui/chrome';
import { IconSwitch } from '../ui/IconSwitch';
import { ColumnsRow, StackedRow } from './ThreadRow';
import { type ThreadState, threadByHandle } from './thread';
import { isViewId, type MailboxId, olderAvailable, syncProgressIn } from './views';

/** The list over a mailbox: search, the layout switch, the rows, the empty states and Older mail. */
type Layout = 'columns' | 'stacked';

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

/**
 * Only the rows in view, and a few either side, are in the DOM, so a mailbox of thousands renders
 * like one of thirty. Each row is measured: a folded or stacked record is as tall as its content.
 */
const ThreadRows = ({
  threads,
  mailbox,
  openId,
  isStacked,
}: {
  threads: readonly ThreadState[];
  mailbox: MailboxId;
  openId: string | undefined;
  isStacked: boolean;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row holding focus stays mounted when it scrolls away, or focus would fall to the page.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusedIndex = threads.findIndex(thread => thread.id === focusedId);
  const virtualizer = useVirtualizer({
    count: threads.length,
    getScrollElement: () => scrollRef.current,
    // A typical record's measured height, so the scrollbar is close to right before rows are drawn.
    estimateSize: () => (isStacked ? 104 : 34),
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

  const Row = isStacked ? StackedRow : ColumnsRow;
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
              // Stacked records have no columns to carry the structure, so they keep their dividers
              // at every width; column records drop them at `lg`, where the columns do that job.
              className={cn(
                'absolute inset-x-0 top-0',
                index > 0 && 'border-t border-rule-soft',
                !isStacked && 'lg:border-t-0',
              )}
              style={{ transform: `translateY(${start}px)` }}
            >
              <Row thread={thread} mailbox={mailbox} isSelected={thread.id === openId} />
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
  const [layout, setLayout] = useChromePref<Layout>('yozz:list-layout', 'columns', raw =>
    raw === 'stacked' ? 'stacked' : 'columns',
  );
  const isStacked = layout === 'stacked';

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
          // Named: an unnamed field trips Chrome's autofill advisory, and here remembering is wanted.
          name="search"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search sender, subject or address"
          aria-label="Search mail"
          className="h-full w-full min-w-0 bg-transparent text-base text-paper outline-none placeholder:text-paper-faint"
        />
        <IconSwitch label="List layout" options={LAYOUTS} value={layout} onChange={setLayout} />
      </div>

      {threads.length === 0 ? (
        empty
      ) : (
        <ThreadRows
          // A switch starts from fresh measurements: the other shape's heights mean nothing here.
          key={layout}
          threads={threads}
          mailbox={mailbox}
          openId={openId}
          isStacked={isStacked}
        />
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
