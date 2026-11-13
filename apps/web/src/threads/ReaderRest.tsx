import { useMail } from '../store/MailProvider';
import { useListing } from './use-listing';
import { nameOfView } from './view-name';

/**
 * The reader with nothing open: one quiet line about the list beside it, and nothing about YOZZ.
 * With no address yet the line says so and offers nothing: the list beside it holds the one button.
 */
export const ReaderRest = () => {
  const { mailboxes } = useMail();
  const listing = useListing();

  if (mailboxes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-ink-sunken px-8">
        <p className="text-base text-paper-faint">No address connected yet.</p>
      </div>
    );
  }

  const threads = listing?.threads ?? [];
  const unread = threads.filter(thread => thread.isUnread).length;
  const line =
    listing === undefined || threads.length === 0
      ? 'Nothing selected'
      : [
          listing.isSearch ? null : nameOfView(listing.view),
          unread > 0
            ? `${unread} unread`
            : `${threads.length} ${threads.length === 1 ? 'conversation' : 'conversations'}`,
        ]
          .filter(part => part !== null)
          .join(' · ');

  return (
    <div className="flex h-full items-center justify-center bg-ink-sunken px-8">
      <p className="max-w-full truncate text-base text-paper-faint">{line}</p>
    </div>
  );
};
