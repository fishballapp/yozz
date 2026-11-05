import { useNavigate, useParams } from '@tanstack/react-router';
import { neighbourOf } from '@yozz.app/mail/threads/views';
import { useListing } from './use-listing';

/**
 * Filing the open thread away moves the reader on to its neighbour, or back to the list when it was
 * the last. Call it in the same handler as the move: the list it reads is the one on screen, before
 * the move applies. `alsoFiled` names the other threads the same action takes away, so the reader
 * never moves on to one of them.
 */
export const useAdvancePast = () => {
  const { view } = useParams({ from: '/_app/m/$view' });
  const navigate = useNavigate();
  const listing = useListing();

  return (threadId: string, alsoFiled: ReadonlySet<string> = new Set()) => {
    const staying = (listing?.threads ?? []).filter(
      thread => thread.id === threadId || !alsoFiled.has(thread.id),
    );
    const next = neighbourOf(staying, threadId);
    void navigate(
      next === undefined
        ? { to: '/m/$view', params: { view }, search: previous => previous }
        : {
            to: '/m/$view/t/$',
            params: { view, _splat: next.id },
            search: previous => previous,
            replace: true,
          },
    );
  };
};
