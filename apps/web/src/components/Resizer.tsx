// biome-ignore-all lint/a11y/useSemanticElements: this file is the ARIA window-splitter widget — a focusable separator carrying a range — and no HTML element is one. `<hr>` is a thematic break in CONTENT, and a void element besides, so it can hold neither the grab zone nor a value.

import { cn } from '@fishballapps/cn';
import { useRef, useState } from 'react';

/**
 * The hairline BETWEEN two panes, made draggable. It replaces the pane's own `border-r`, so the
 * separator you grab is the separator you already saw — nothing widens, appears or lights up to
 * announce that this edge is special.
 *
 * Ink & Rule has one separator, so the affordance is the rule's COLOUR, not its size: `--rule-soft`
 * at rest, `--paper-faint` under the pointer, `--paper` while dragging, `--signal` on keyboard
 * focus (focus is one of the three things the accent is allowed to buy). The line never grows —
 * a 1px rule that becomes a 4px slab on hover is a scrollbar, not a rule.
 *
 * The grab zone does grow, invisibly: a 9px child straddles the line so the pointer does not have
 * to find a single pixel. It sits OUTSIDE the flow box, so widening it never moves a pane.
 *
 * Desktop only. Below `lg` the panes are shown one at a time and there is no edge to drag.
 */

/**
 * The rail's designed width and its drag bounds, in px. It lives here rather than in either shell
 * because the mailbox and the page shell must agree: the rail is one object, and navigating to
 * Settings must not resize it.
 */
/**
 * `max` is 304, not 320, so the shell still fits its narrowest supported viewport: at exactly
 * 1024px (iPad mini landscape, and the `lg` breakpoint itself) a 320px rail leaves 702px against
 * the list's 320 and the reader's 384 floors, and the page overflows horizontally by 2px.
 */
export const RAIL_WIDTH = { min: 176, max: 304, base: 224 };
export const Resizer = ({
  label,
  width,
  min,
  max,
  onResize,
  onReset,
}: {
  /** Names the pane being sized, e.g. "Mailbox list width" — this is the control's whole label. */
  label: string;
  /** The pane's stored width. Used for the keyboard step and the announced value, not the drag. */
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

  /**
   * The pane's RENDERED width, not its stored one. The two diverge whenever the viewport has
   * squeezed the pane below the width you asked for, and both interactions have to start from what
   * is actually on screen — a keyboard stepping from the stored number moves an invisible value:
   * at a 490px pane with 720 stored, ArrowLeft has to be pressed fifteen times before a pixel moves.
   */
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
        // Primary button only. `pointerdown` fires for whichever button goes down first, so
        // without this a middle-press resizes the pane and a right-press opens the context menu
        // over a handle that has already taken the drag — and on platforms that then withhold
        // `lostpointercapture`, the pane keeps tracking a cursor with no button held. `isPrimary`
        // covers the same hole for touch: a second finger would otherwise overwrite the drag
        // origin mid-gesture and kill the drag when it lifts.
        if (event.button !== 0 || !event.isPrimary) return;
        // Suppresses the drag-selection the pointer would otherwise start across both panes.
        // Focus is then moved by hand, since preventDefault would have skipped it.
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
