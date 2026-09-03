import { cn } from '@fishballapps/cn';
import { type Icon, MagnifyingGlassIcon, RowsIcon, TableIcon } from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { describeMailFailure } from '../relay/describe-failure';
import { useMail } from '../store/MailProvider';
import { buttonClass } from '../ui/Button';
import { useChromePref } from '../ui/chrome';
import { IconSwitch } from '../ui/IconSwitch';
import { ColumnsRow, DESKTOP_COLUMNS, StackedRow } from './ThreadRow';
import type { ThreadState } from './thread';
import { isViewId, type MailboxId, olderAvailable, syncProgressIn } from './views';

/** The list over a mailbox: search, the layout switch, the rows, the empty states and Older mail. */
type Layout = 'columns' | 'stacked';

/** Above `lg` only: the folded column record has no columns to head. */
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
  // Which row is open is a fact about the URL, so the row link and its inversion cannot disagree.
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
          // Named: an unnamed field trips Chrome's autofill advisory, and here remembering is wanted.
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
