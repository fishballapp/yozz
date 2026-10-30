import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { neighbourOf, visibleThreads } from '@yozz.app/mail/threads/views';
import { useMail } from '../store/MailProvider';

/**
 * Filing the open thread away moves the reader on to its neighbour, or back to the list when it was
 * the last. Call it in the same handler as the move: the list it reads is the one on screen, before
 * the move applies. `alsoFiled` names the other threads the same action takes away, so the reader
 * never moves on to one of them.
 */
export const useAdvancePast = () => {
  const { mailbox } = useParams({ from: '/_app/m/$mailbox' });
  const { q } = useSearch({ from: '/_app/m/$mailbox' });
  const navigate = useNavigate();
  const { threads } = useMail();

  return (threadId: string, alsoFiled: ReadonlySet<string> = new Set()) => {
    const staying = visibleThreads(threads, mailbox, q).filter(
      thread => thread.id === threadId || !alsoFiled.has(thread.id),
    );
    const next = neighbourOf(staying, threadId);
    void navigate(
      next === undefined
        ? { to: '/m/$mailbox', params: { mailbox }, search: previous => previous }
        : {
            to: '/m/$mailbox/t/$',
            params: { mailbox, _splat: next.id },
            search: previous => previous,
            replace: true,
          },
    );
  };
};
