import { cn } from '@fishballapps/cn';
import { Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Resizer } from '../components/Resizer';
import { ThreadList } from '../components/ThreadList';
import { useMediaQuery, usePaneWidth } from '../lib/chrome';
import { useMail, visibleThreads } from '../state/mail';

/**
 * THE FIRST VIEWPORT: rail, list, reader, status line — three ruled columns over one warm ink
 * ground, with no card, panel, shadow or rounded corner anywhere. What the eye should catch first
 * is the density of the list and the single inverted bar marking the open message.
 *
 * The rail and the status line belong to `AppShell` above this. What is here is the list column,
 * its resizer, and the reader pane — which is an `<Outlet/>`, because what fills it is a route: the
 * mailbox's index route when nothing is open, the thread route when something is.
 *
 * The list column still never TRACKS the viewport — that is the rule this layout exists to protect,
 * because columns that move as you resize the window are exactly what a fixed-column list is for. A
 * width you set by hand is the opposite of that: it is chosen once and then holds.
 *
 * The reader keeps a `24rem` floor and the list is allowed to shrink, so a narrowing window eats
 * the list before it ever squeezes the message you are reading. That is CSS doing the arbitration,
 * not a resize listener — the stored width is your intent, and the viewport is free to disagree
 * with it temporarily without overwriting it.
 *
 * Below `lg` the two panes become one at a time: opening a message replaces the list rather than
 * squeezing beside it, and there is no edge to drag.
 */

/** The designed list widths, and what double-clicking the hairline returns to. */
const LIST_WIDTH = { min: 320, max: 720, wide: 528, base: 432 };

export const Mailbox = () => {
  const { mailbox } = useParams({ from: '/_app/m/$mailbox' });
  const { q } = useSearch({ from: '/_app/m/$mailbox' });
  // `to: '.'` and NO `from`, and both halves matter. The destination path resolves from
  // `from ?? currentDeepestMatch`, so `from: '/m/$mailbox'` silently dropped `/t/$` and
  // typing in the search box CLOSED the message you were reading — `replace: true` erasing it from
  // history as well. Without `from`, `'.'` is wherever you actually are, thread included; this is
  // the same resolution every `<Link to=".">` in the app relies on.
  const navigate = useNavigate();
  const { threads } = useMail();

  // Whether a message is open is a question about the URL, not about state this component holds:
  // the thread route is what puts a `threadId` in scope. Below `lg` that is also what decides
  // whether the list is on screen at all.
  const { _splat: threadId } = useParams({ strict: false });
  const isReading = threadId !== undefined;

  // The default still STEPS at `xl`, the way the fixed layout did, and it stays live: a list you
  // never dragged still widens when the window crosses the breakpoint. Dragging replaces the step
  // with your number; double-clicking the hairline hands the step back.
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
          // `replace` because a search box is one thought, not one history entry per keystroke —
          // without it, Back walks you backwards through the word you just typed.
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
