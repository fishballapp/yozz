import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMail } from '../store/MailProvider';
import { neighbourOf, visibleThreads } from './views';

/**
 * Filing the open thread away moves the reader on to its neighbour, or back to the list when it was
 * the last. Call it in the same handler as the move: the list it reads is the one on screen, before
 * the move applies.
 */
export const useAdvancePast = () => {
  const { mailbox } = useParams({ from: '/_app/m/$mailbox' });
  const { q } = useSearch({ from: '/_app/m/$mailbox' });
  const navigate = useNavigate();
  const { threads } = useMail();

  return (threadId: string) => {
    const next = neighbourOf(visibleThreads(threads, mailbox, q), threadId);
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
