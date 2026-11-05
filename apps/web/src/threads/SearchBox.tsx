import { MagnifyingGlassIcon, XIcon } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { useMediaQuery } from '../ui/chrome';

/** The box's type, in one place: mono because a machine parses it, and 16px so a phone doesn't zoom. */
const BOX_TYPE = 'font-mono text-[16px] leading-5 py-3 lg:text-base lg:leading-4.5 lg:py-3.25';

/**
 * The query behind the list, always, in an ordinary text field. It wraps rather than scrolling
 * sideways, so it is a textarea; it stays one logical line, so Enter submits and a pasted line break
 * becomes a space. What is typed stays as typed (a trailing space, the caret where it was), and the
 * box goes back to the query when focus leaves or the list moves on by another road (Back, the rail).
 */
export const SearchBox = ({
  query,
  stillShows,
  onQueryChange,
  onSubmit,
  onLeave,
}: {
  query: string;
  /** This text means what the list on screen holds. */
  stillShows: (text: string) => boolean;
  /** `isUrlBehind`: a keystroke before this one has yet to reach the URL, so `stillShows` is out of date. */
  onQueryChange: (text: string, isUrlBehind: boolean) => void;
  /** Enter, or a phone's Search key: no more than don't wait. */
  onSubmit: (text: string) => void;
  /** Focus left the box. */
  onLeave: () => void;
}) => {
  const isWide = useMediaQuery('(min-width: 64rem)');
  // The router commits a keystroke's URL after the render it causes, so what is typed holds for as
  // long as the URL says something it was asked to: where it stood at the first keystroke, or one on
  // the way. Anything else came by another road. Each it reaches retires those before it.
  const [editing, setEditing] = useState<{
    readonly typed: string;
    readonly asked: readonly string[];
  } | null>(null);
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
        {/* The hidden copy sizes the cell, so the field grows with what it holds at any width. The
            column holds its width, or one long word would widen it over the ✕ instead of breaking. */}
        <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] *:col-start-1 *:row-start-1">
          <span aria-hidden className={`invisible break-words whitespace-pre-wrap ${BOX_TYPE}`}>
            {text}{' '}
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
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={text}
            onChange={event => change(event.target.value.replace(/\s*[\r\n]+\s*/gu, ' '))}
            onBlur={() => {
              setEditing(null);
              onLeave();
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
            placeholder="Search mail"
            className={`w-full resize-none overflow-hidden bg-transparent break-words text-paper outline-none placeholder:font-sans placeholder:text-paper-faint ${BOX_TYPE}`}
          />
        </div>
        {text !== '' && (
          <button
            type="button"
            aria-label="Clear search"
            // Focus stays in the field, so typing goes on from the empty box.
            onMouseDown={event => event.preventDefault()}
            onClick={() => {
              change('');
              field.current?.focus();
            }}
            // Above `lg` the glyph's edge lands on the time column's, and the hit area reaches the rule.
            className="flex size-11 shrink-0 items-center justify-center text-paper-faint -outline-offset-2 hover:text-paper lg:w-8 lg:justify-end lg:pr-1.5"
          >
            <XIcon size={13} />
          </button>
        )}
      </form>
    </search>
  );
};
