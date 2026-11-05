import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { planOf } from '@yozz.app/mail/threads/server-search';
import { type Listing, viewOfQuery, viewShown } from '@yozz.app/mail/threads/views';
import { type ReactNode, useRef } from 'react';
import { useMail } from '../store/MailProvider';
import { SearchBox } from './SearchBox';

/**
 * The one line under the box, when there is something to say and only then: what went wrong, ahead
 * of what a search is doing. Nothing says fetching unless a search is under way, so it cannot hang.
 */
const ListLine = ({ query }: { query: string }) => {
  const { mailboxes, syncStates, mailError, sentCopyError, sync, serverSearch, search } = useMail();
  const hostOf = (address: string) =>
    mailboxes.find(mailbox => mailbox.address === address)?.imap.host ?? address;
  const running = serverSearch?.query === query ? serverSearch : null;
  const line = (() => {
    const failedMailbox = mailboxes.find(({ address }) => syncStates[address]?.status === 'failed');
    const failedSync = failedMailbox === undefined ? undefined : syncStates[failedMailbox.address];
    if (failedMailbox !== undefined && failedSync?.status === 'failed') {
      const text = describeMailFailure(failedSync.failure, failedMailbox.imap.host);
      return { text, whole: text, retry: () => void sync(failedMailbox.address) };
    }
    const problem = sentCopyError ?? mailError;
    if (problem !== null) return { text: problem, whole: problem };
    if (running === null) return null;
    if (running.phase !== 'settled') return { text: 'Fetching more mail…' };
    if (running.failed.length === 0) return null;
    const asked = planOf(query, mailboxes)?.mailboxes.length ?? running.failed.length;
    const addresses = running.failed.map(({ address }) => address).join(', ');
    return {
      text: `${running.failed.length} of ${asked} ${asked === 1 ? 'mailbox' : 'mailboxes'} couldn't be searched. ${addresses} may be missing results.`,
      whole: running.failed
        .map(({ address, failure }) => describeMailFailure(failure, hostOf(address)))
        .join('\n'),
      retry: () => search.retry(),
    };
  })();
  if (line === null) return null;

  return (
    <p
      title={line.whole}
      className="-mt-1 flex min-w-0 items-center gap-1 pr-2 pb-2.5 pl-14 text-2xs text-paper-faint lg:items-baseline lg:gap-3 lg:pl-8.5"
    >
      <span className="min-w-0">{line.text}</span>
      {line.retry !== undefined && (
        <button
          type="button"
          onClick={line.retry}
          // A 44px target on a phone, without making the line that tall.
          className="-my-1.5 ml-auto flex min-h-11 shrink-0 items-center pl-3 text-paper-dim underline underline-offset-3 transition-colors hover:text-paper lg:my-0 lg:min-h-0 lg:pl-0"
        >
          Retry
        </button>
      )}
    </p>
  );
};

/**
 * The box over a list and the line under it. A view's own query stays out of the URL, and any other
 * sits on `/m/unified`: one link per query, wherever it was typed. The first keystroke adds a history
 * entry, so Back returns to the list, and the later ones replace it. Typing filters this device's
 * mail at once and asks the servers after a pause; Enter skips the pause.
 */
export const SearchRow = ({
  listing: { query },
  leading,
  trailing,
}: {
  listing: Listing;
  leading?: ReactNode;
  trailing?: ReactNode;
}) => {
  const { view, _splat: threadId } = useParams({ strict: false });
  const { q } = useSearch({ strict: false });
  const navigate = useNavigate();
  const { mailboxes, search } = useMail();
  const hasBackEntry = useRef(false);

  const stillShows = (text: string) => {
    const own = viewOfQuery(text, mailboxes);
    if (own !== null) return view !== undefined && viewShown(view, q, mailboxes) === own;
    return text.trim() === q?.trim();
  };

  const showQuery = (text: string, isUrlBehind = false) => {
    if (!isUrlBehind && stillShows(text)) return;
    const own = viewOfQuery(text, mailboxes);
    const target = {
      search: <T,>(previous: T) => ({ ...previous, q: own === null ? text.trim() : undefined }),
      replace: hasBackEntry.current,
    };
    hasBackEntry.current = true;
    const shownView = own ?? 'unified';
    // An open message stays open: typing in the box is no reason to close it.
    void navigate(
      threadId === undefined
        ? { to: '/m/$view', params: { view: shownView }, ...target }
        : { to: '/m/$view/t/$', params: { view: shownView, _splat: threadId }, ...target },
    );
  };

  return (
    // Below `lg` this is the shell's top bar, and takes a bar's ground.
    <div className="shrink-0 border-b border-rule-soft bg-ink-raised lg:bg-transparent">
      <div className="flex items-start">
        {leading}
        <SearchBox
          query={query}
          stillShows={stillShows}
          onQueryChange={(text, isUrlBehind) => {
            search.type(text);
            showQuery(text, isUrlBehind);
          }}
          onSubmit={text => {
            search.now(text);
            showQuery(text);
          }}
          onLeave={() => {
            hasBackEntry.current = false;
          }}
        />
        {trailing}
      </div>
      <ListLine query={query.trim()} />
    </div>
  );
};
