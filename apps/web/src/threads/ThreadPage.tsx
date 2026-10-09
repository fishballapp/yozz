import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { keepCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { ThreadReader } from './ThreadReader';
import { threadByHandle } from './thread';
import { useAdvancePast } from './use-advance';

/** Resolved against the whole store, not the filtered list, so a search must not unmount the open message. */
export const ThreadPage = () => {
  const { mailbox, _splat: threadId } = useParams({ from: '/_app/m/$mailbox/t/$' });
  const navigate = useNavigate({ from: '/m/$mailbox/t/$' });
  const { threads, markRead, loadBody } = useMail();
  const advancePast = useAdvancePast();
  // The root can change under a URL (paging, a move), so the id is tried as a message of a thread before it is called missing.
  const thread = threadByHandle(threads, threadId ?? '');

  // Effects, not click handlers, so a direct link marks read and fetches too. Once per thread and
  // newest message on screen, read or not: a refused write is not retried on every render, but
  // mail arriving is marked, and so is a thread opened again after another.
  const shownRef = useRef<string | null>(null);
  useEffect(() => {
    const shown = thread === null ? null : `${thread.id}/${thread.messages.at(-1)?.id}`;
    if (shownRef.current === shown) return;
    shownRef.current = shown;
    if (thread !== null && thread.isUnread) markRead(thread.id);
  }, [thread, markRead]);
  useEffect(() => {
    if (thread === null) return;
    for (const message of thread.messages) {
      if (message.bodyStatus === 'pending') loadBody(thread.id, message.id);
    }
  }, [thread, loadBody]);

  if (thread === null) return <ThreadMissing />;

  return (
    <ThreadReader
      thread={thread}
      onTriaged={() => advancePast(thread.id)}
      // Closing keeps the search.
      onClose={() =>
        navigate({ to: '/m/$mailbox', params: { mailbox }, search: previous => previous })
      }
    />
  );
};

/** Stated in the pane that owns the message; everything else on screen is still true. */
const ThreadMissing = () => (
  <div className="flex h-full flex-col items-center justify-center gap-3 bg-ink-sunken px-8 text-center">
    <p className="label-rule">No such message</p>
    <p className="max-w-xs text-base leading-relaxed text-paper-dim">
      This link points at a message that is not in your mail. It may have been archived or removed.
    </p>
    <Link
      to="/m/$mailbox"
      params={{ mailbox: 'unified' }}
      search={keepCompose}
      className="text-base text-signal underline-offset-2 hover:underline"
    >
      Back to the inbox
    </Link>
  </div>
);
