import { cn } from 'cn';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * An address that gives up its start, not its end, when its cell is too narrow: what follows the `@`
 * says who sent it, so `…@stripe-invoices.top` stays and `notice@stripe-invo…` does not. The
 * characters are never reordered (a `direction: rtl` ellipsis moves punctuation); the text is laid
 * out whole and the box clips its start. It is drawn under the row's link, which a pointer
 * reaches instead, so the whole address is the link's `title` and its accessible name, not here.
 */
export const TailClipped = ({ text }: { text: string }) => {
  const box = useRef<HTMLSpanElement>(null);
  const whole = useRef<HTMLSpanElement>(null);
  const [isClipped, setIsClipped] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is what is measured.
  useLayoutEffect(() => {
    const [measured, measuring] = [box.current, whole.current];
    if (measured === null || measuring === null) return;
    const measure = () => setIsClipped(measuring.offsetWidth > measured.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    // Both: the box when the cell is resized, the text when its weight changes (unread to read) or a
    // late web font lands.
    observer.observe(measured);
    observer.observe(measuring);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span ref={box} dir="ltr" className="flex min-w-0">
      {isClipped && <span className="shrink-0">…</span>}
      <span
        className={cn(
          'flex min-w-0 flex-1 overflow-hidden',
          isClipped &&
            // The cut can fall inside a letter; fading the edge reads as a cut, not as a broken glyph.
            'justify-end [mask-image:linear-gradient(to_right,transparent,black_0.5rem)]',
        )}
      >
        <span ref={whole} className="shrink-0 whitespace-nowrap">
          {text}
        </span>
      </span>
    </span>
  );
};
