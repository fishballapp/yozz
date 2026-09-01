import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ThreadReader } from '../components/ThreadReader';
import { keepCompose } from '../lib/compose';
import { threadByHandle } from '../lib/thread';
import { useMail, visibleThreads } from '../state/mail';

/**
 * The reader pane, filled.
 *
 * The thread is resolved against the whole store rather than the mailbox's filtered list, because a
 * search running in the list must not unmount the message you are reading — you narrow the list to
 * find the next thing while the current one stays open.
 */
export const Thread = () => {
  const { mailbox, _splat: threadId } = useParams({ from: '/_app/m/$mailbox/t/$' });
  const navigate = useNavigate({ from: '/m/$mailbox/t/$' });
  const { q } = useSearch({ from: '/_app/m/$mailbox' });
  const { threads, markRead, loadBody } = useMail();
  // A thread is named by its root message, and the root can change under a URL — paging in an
  // older message, or a move that relocates it — so an id that no longer names a thread is tried
  // as a message of one before it is called missing.
  const thread = threadByHandle(threads, threadId ?? '');

  // Opening a message marks it read and fetches its body — including on a direct link, which is
  // why both are effects rather than click handlers. A failed body is retried from the reader.
  useEffect(() => {
    if (thread !== null && thread.isUnread) markRead(thread.id);
  }, [thread, markRead]);
  useEffect(() => {
    if (thread === null) return;
    for (const message of thread.messages) {
      if (message.bodyStatus === 'pending') loadBody(thread.id, message.id);
    }
  }, [thread, loadBody]);

  if (thread === null) return <ThreadMissing />;

  // Filing a thread opens the one after it in the list on screen (the one before it at the end,
  // the mailbox when it was alone). Computed from the list as it is NOW, before the move has
  // applied: once it has, the thread is no longer in this list to measure from.
  const advance = () => {
    const list = visibleThreads(threads, mailbox, q);
    const index = list.findIndex(candidate => candidate.id === thread.id);
    const next = list[index + 1] ?? list[index - 1];
    if (next === undefined || index === -1) {
      void navigate({ to: '/m/$mailbox', params: { mailbox }, search: previous => previous });
      return;
    }
    void navigate({
      to: '/m/$mailbox/t/$',
      params: { mailbox, _splat: next.id },
      search: previous => previous,
      replace: true,
    });
  };

  return (
    <ThreadReader
      thread={thread}
      onTriaged={advance}
      // Closing keeps the search: you narrowed the list to find this, and you are probably about to
      // open the next one from the same narrowed list.
      onClose={() =>
        navigate({ to: '/m/$mailbox', params: { mailbox }, search: previous => previous })
      }
    />
  );
};

/**
 * A link to a message that is not there — archived on another device, deleted, or a URL that was
 * never right. It is stated in the pane that owns the message, with the rail and the list still
 * beside it, because everything else on screen is still true. A whole-page 404 would throw away a
 * working app to report one missing row.
 */
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
