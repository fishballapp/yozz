// biome-ignore-all lint/a11y/useSemanticElements: this file is the ARIA window-splitter widget — a focusable separator carrying a range — and no HTML element is one. `<hr>` is a thematic break in CONTENT, and a void element besides, so it can hold neither the grab zone nor a value.

import { cn } from '@fishballapps/cn';
import { useRef, useState } from 'react';

/**
 * The pane's own `border-r`, made draggable: the affordance is the rule's colour, never its
 * size, and an invisible 9px grab zone straddles it outside the flow box. Desktop only.
 */

/** Here rather than in either shell, because the mailbox and the page shell must agree on the rail. */
/** 304, not 320: at exactly 1024px a 320px rail overflows the list and reader floors by 2px. */
export const RAIL_WIDTH = { min: 176, max: 304, base: 224 };
export const Resizer = ({
  label,
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  /** The control's whole label, e.g. "Mailbox list width". */
  label: string;
  /** Used for the keyboard step and the announced value, not the drag. */
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  /** Double-click returns the pane to its designed width. */
  onReset: () => void;
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));

  /** The rendered width, not the stored one: a keyboard step from a stored 720 on a 490px pane moves nothing visible for fifteen presses. */
  const measure = (handle: HTMLElement) => {
    const pane = handle.previousElementSibling;
    return pane instanceof HTMLElement ? pane.getBoundingClientRect().width : width;
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={event => {
        // Primary button only: a middle-press would take the drag, and a right-press opens the context
        // menu over it; on platforms that then withhold `lostpointercapture` the pane tracks a cursor
        // with no button held. `isPrimary` covers a second finger the same way.
        if (event.button !== 0 || !event.isPrimary) return;
        // Suppresses drag-selection across both panes; focus is then moved by hand.
        event.preventDefault();
        const handle = event.currentTarget;
        handle.focus();
        handle.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width: measure(handle) };
        setIsDragging(true);
      }}
      onPointerMove={event => {
        if (!isDragging) return;
        onResize(clamp(start.current.width + event.clientX - start.current.x));
      }}
      onLostPointerCapture={() => setIsDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16;
        const from = measure(event.currentTarget);
        if (event.key === 'ArrowLeft') onResize(clamp(from - step));
        else if (event.key === 'ArrowRight') onResize(clamp(from + step));
        else if (event.key === 'Home') onResize(min);
        else if (event.key === 'End') onResize(max);
        else return;
        event.preventDefault();
      }}
      className={cn(
        'relative z-20 hidden w-px shrink-0 cursor-col-resize touch-none outline-none transition-colors lg:block',
        isDragging ? 'bg-paper' : 'bg-rule-soft hover:bg-paper-faint focus-visible:bg-signal',
      )}
    >
      {/* The grab zone extends only to the RIGHT of the line. Straddling it put 4px of the target
          over the preceding pane's scrollbar track, which on classic (non-overlay) scrollbars means
          grabbing the last few pixels of the list's scrollbar starts a pane drag instead of
          scrolling. Invisible on macOS, broken on Windows and Linux. */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-2.25" />
    </div>
  );
};
