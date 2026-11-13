import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { useRef, useState } from 'react';
import { useMediaQuery } from '../ui/chrome';
import { Tooltip } from '../ui/Tooltip';

/** The cell's line, shared by the query and the view's name so the bar is 44px under either. */
const BOX_LINE = 'leading-5 py-3 lg:leading-4.5 lg:py-3.25';
/** The query's type: mono because a machine parses it, and 16px so a phone doesn't zoom. */
const QUERY_TYPE = `font-mono text-[16px] lg:text-base ${BOX_LINE}`;

/**
 * The query behind the list, in an ordinary text field, in three states (docs/search.md). Over a
 * view at rest it shows the view's name; focused over a view it shows that view's own query, all of
 * it selected, so typing replaces it and an arrow key keeps it; over a search it shows the query,
 * focused or not.
 *
 * A search wraps rather than scrolling sideways, so the field is a textarea; it stays one logical
 * line, so Enter submits and a pasted line break becomes a space. A view's own query does not wrap:
 * over a view the box is one line that scrolls sideways, so an address's query cannot push the list
 * down. What is typed stays as typed (a trailing space, the caret where it was), and the box goes
 * back to the query when focus leaves or the list moves on by another road (Back, the rail).
 */
export const SearchBox = ({
  query,
  viewName,
  stillShows,
  onQueryChange,
  onSubmit,
  onLeave,
  onClose,
}: {
  query: string;
  /** The name of the view the list is, or null over a search. */
  viewName: string | null;
  /** This text means what the list on screen holds. */
  stillShows: (text: string) => boolean;
  /** `isUrlBehind`: a keystroke before this one has yet to reach the URL, so `stillShows` is out of date. */
  onQueryChange: (text: string, isUrlBehind: boolean) => void;
  /** Enter, or a phone's Search key: no more than don't wait. */
  onSubmit: (text: string) => void;
  /** Focus left the box. */
  onLeave: () => void;
  /** The ✕ over a search: back to the view it began from. */
  onClose: () => void;
}) => {
  const isWide = useMediaQuery('(min-width: 64rem)');
  // The router commits a keystroke's URL after the render it causes, so what is typed holds for as
  // long as the URL says something it was asked to: where it stood at the first keystroke, or one on
  // the way. Anything else came by another road. Each it reaches retires those before it.
  const [editing, setEditing] = useState<{
    readonly typed: string;
    readonly asked: readonly string[];
  } | null>(null);
  const [isFocused, setIsFocused] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const reached = editing?.asked.findIndex(stillShows) ?? -1;
  if (editing !== null && reached !== 0) {
    setEditing(reached === -1 ? null : { ...editing, asked: editing.asked.slice(reached) });
  }
  const text = editing !== null && reached !== -1 ? editing.typed : query;
  const change = (next: string) => {
    const asked = reached === -1 || editing === null ? [text] : editing.asked.slice(reached);
    setEditing({ typed: next, asked: [...asked, next] });
    onQueryChange(next, asked.length > 1);
  };
  const isResting = viewName !== null && !isFocused;
  /** Into the field over a view, with its query selected whole. */
  const enter = () => {
    field.current?.focus();
    field.current?.setSelectionRange(0, field.current.value.length);
  };
  // Over a view the query is the view's own, which is only ever read: one line, scrolled sideways.
  const isOneLine = viewName !== null;

  return (
    <search className="min-w-0 flex-1">
      <form
        className="flex items-start"
        onSubmit={event => {
          event.preventDefault();
          onSubmit(text);
          // Off a phone's keyboard, which covers the answer.
          if (!isWide) field.current?.blur();
        }}
      >
        {/* Over the rows' boxes, so the query starts over their stars; below `lg` the hamburger leads. */}
        <span className="ml-1 hidden h-11 w-7.5 shrink-0 items-center justify-center lg:flex">
          <MagnifyingGlassIcon size={14} className="text-paper-faint" />
        </span>
        {/* The hidden copy sizes the cell, so the field grows with what it holds at any width; at
            rest it holds nothing, so the name keeps the bar to one line. The column holds its
            width, or one long word would widen it over the ✕ instead of breaking. */}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] *:col-start-1 *:row-start-1">
          <span
            aria-hidden
            className={cn(
              'invisible',
              isOneLine ? 'truncate' : 'break-words whitespace-pre-wrap',
              QUERY_TYPE,
            )}
          >
            {isResting ? '' : text}{' '}
          </span>
          {/* biome-ignore lint/a11y/useSemanticElements: a search input cannot wrap, and this does. */}
          <textarea
            ref={field}
            role="searchbox"
            aria-label="Search mail"
            aria-multiline={false}
            // Named: an unnamed field trips Chrome's autofill advisory, and here remembering is wanted.
            name="search"
            rows={1}
            wrap={isOneLine ? 'off' : 'soft'}
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            onChange={event => change(event.target.value.replace(/\s*[\r\n]+\s*/gu, ' '))}
            onFocus={event => {
              setIsFocused(true);
              // As a browser's address bar does: typing replaces the view's query, an arrow keeps it.
              if (viewName !== null) event.currentTarget.setSelectionRange(0, text.length);
            }}
            onBlur={() => {
              setIsFocused(false);
              setEditing(null);
              onLeave();
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Escape') event.currentTarget.blur();
              if (event.key !== 'Enter') return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="Search all mail"
            className={cn(
              'w-full resize-none bg-transparent text-paper outline-none placeholder:font-sans placeholder:text-paper-faint',
              // The scrollbar is hidden: it would take its 10px out of the line.
              isOneLine
                ? 'overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
                : 'overflow-hidden break-words',
              QUERY_TYPE,
              // Still in the tab order, under the name.
              isResting && 'opacity-0',
            )}
          />
          {isResting && (
            <span
              aria-hidden
              // No caret placed by the browser: the press selects the whole query instead.
              onMouseDown={event => {
                event.preventDefault();
                enter();
              }}
              className={`z-10 cursor-text truncate text-base font-medium text-paper ${BOX_LINE}`}
            >
              {viewName}
            </span>
          )}
        </div>
        {/* Wide, at rest over a view: the box reads as a title, so say it takes typing. */}
        {isResting && (
          <span
            aria-hidden
            onMouseDown={event => {
              event.preventDefault();
              enter();
            }}
            className="hidden h-11 shrink-0 cursor-text items-center gap-2 pr-2 text-2xs text-paper-faint lg:flex"
          >
            Search all mail
          </span>
        )}
        {viewName === null ? (
          <Tooltip label="Close search">
            <button
              type="button"
              aria-label="Close search"
              onClick={() => {
                // Left first, so the way back is a new history entry and Back returns to the search.
                field.current?.blur();
                onClose();
              }}
              // Above `lg` the glyph's edge lands on the time column's, and the hit area reaches the rule.
              className="flex size-11 shrink-0 items-center justify-center text-paper-faint -outline-offset-2 hover:text-paper lg:w-8 lg:justify-end lg:pr-1.5"
            >
              <XIcon size={13} />
            </button>
          </Tooltip>
        ) : (
          // Below `lg` nothing else says the title is also the search; above it the glyph leads.
          <button
            type="button"
            aria-label="Search"
            onMouseDown={event => event.preventDefault()}
            onClick={enter}
            className="flex size-11 shrink-0 items-center justify-center text-paper-faint -outline-offset-2 hover:text-paper lg:hidden"
          >
            <MagnifyingGlassIcon size={16} />
          </button>
        )}
      </form>
    </search>
  );
};
