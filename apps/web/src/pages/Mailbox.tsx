import { cn } from '@fishballapps/cn';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Resizer } from '../components/Resizer';
import { ThreadList } from '../components/ThreadList';
import { useMediaQuery, usePaneWidth } from '../lib/chrome';
import { useMail, visibleThreads } from '../state/mail';

/**
 * The list column, its resizer, and the reader `<Outlet/>`; the rail and status line are
 * `AppShell`'s. The list never tracks the viewport; the reader keeps a `24rem` floor and CSS
 * arbitrates. Below `lg` the panes show one at a time.
 */

/** The designed list widths, and what double-clicking the hairline returns to. */
const LIST_WIDTH = { min: 320, max: 720, wide: 528, base: 432 };

export const Mailbox = () => {
  const { mailbox } = useParams({ from: '/_app/m/$mailbox' });
  const { q } = useSearch({ from: '/_app/m/$mailbox' });
  // `to: '.'` with no `from`: `from: '/m/$mailbox'` resolved without `/t/$` and typing in the
  // search box closed the open message.
  const navigate = useNavigate();
  const { threads } = useMail();

  // Whether a message is open is a question about the URL: the thread route puts a `threadId` in scope.
  const { _splat: threadId } = useParams({ strict: false });
  const isReading = threadId !== undefined;

  // The default still steps at `xl` and stays live; dragging replaces the step, double-click hands it back.
  const [listWidth, setListWidth, resetListWidth] = usePaneWidth(
    'yozz:list-width',
    useMediaQuery('(min-width: 80rem)') ? LIST_WIDTH.wide : LIST_WIDTH.base,
    LIST_WIDTH.min,
    LIST_WIDTH.max,
  );

  return (
    <>
      {/* `lg:flex-initial` rather than `flex-none`: the list keeps the width you gave it but is
          still allowed to give ground, so a narrowing window takes it from here and not from
          the reader. Below `lg` the inline width is inert — `flex-1`'s zero basis wins. */}
      <section
        style={{ width: listWidth }}
        className={cn(
          'min-w-0 flex-col lg:flex lg:min-w-80 lg:flex-initial',
          isReading ? 'hidden' : 'flex flex-1',
        )}
        aria-label="Messages"
      >
        <ThreadList
          threads={visibleThreads(threads, mailbox, q)}
          mailbox={mailbox}
          query={q ?? ''}
          // `replace`: a search box is one thought, not one history entry per keystroke.
          onQueryChange={query =>
            navigate({
              to: '.',
              search: previous => ({ ...previous, q: query.trim() === '' ? undefined : query }),
              replace: true,
            })
          }
        />
      </section>

      <Resizer
        label="Message list width"
        width={listWidth}
        min={LIST_WIDTH.min}
        max={LIST_WIDTH.max}
        onResize={setListWidth}
        onReset={resetListWidth}
      />

      <section
        className={cn('min-w-0 flex-1 lg:min-w-96', isReading ? 'block' : 'hidden lg:block')}
      >
        <Outlet />
      </section>
    </>
  );
};
