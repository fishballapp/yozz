import { useParams, useSearch } from '@tanstack/react-router';
import { assembleMatches, matchesFrontier } from '@yozz.app/mail/threads/found';
import { listingOf } from '@yozz.app/mail/threads/views';
import { useEffect } from 'react';
import { useMail } from '../store/MailProvider';

/** What the list holds for this URL, undefined off the mail. One derivation for every part of the screen. */
export const useListing = () => {
  // `strict: false`: read from above the pages as well as from them.
  const { view } = useParams({ strict: false });
  const { q } = useSearch({ strict: false });
  const { threads, mailboxes, windows, serverSearch } = useMail();
  if (view === undefined) return undefined;
  return listingOf({
    threads,
    view,
    q,
    mailboxes,
    windows,
    ...(serverSearch !== null && serverSearch.query === q?.trim()
      ? {
          isHit: assembleMatches(serverSearch.answers).isHit,
          matchFrontier: matchesFrontier(serverSearch.answers),
          isAnswering: serverSearch.phase !== 'settled',
        }
      : {}),
  });
};

/** A `?q=` nobody typed here is a link opened, or Back: it runs in full, with no pause. */
export const useSearchFollowsUrl = () => {
  const { q } = useSearch({ strict: false });
  const { mailboxes, followSearch } = useMail();
  const hasMailboxes = mailboxes.length > 0;
  useEffect(() => {
    if (hasMailboxes || q === undefined) followSearch(q);
  }, [followSearch, hasMailboxes, q]);
};
