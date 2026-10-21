import { CheckIcon, MinusIcon } from '@phosphor-icons/react';
import { cn } from 'cn';

/**
 * A 13px square box, centred in a hit area the caller sizes: the input fills the whole cell and
 * the box is only its mark. Ticked and mixed both fill with `--signal`.
 *
 * Native rather than Base UI's: React reports a checkbox's change from its `click`, so the event
 * still knows whether Shift was held, and Base UI's re-dispatched click does not.
 */
export const Checkbox = ({
  checked,
  indeterminate = false,
  onCheckedChange,
  label,
  isOnSelect = false,
  className,
}: {
  checked: boolean;
  indeterminate?: boolean;
  /** `extend` is a Shift-click: Gmail's range from the last box you clicked. */
  onCheckedChange: (checked: boolean, extend: boolean) => void;
  label: string;
  /** On the inverted `--select` bar an unticked box's `--paper-faint` edge measures 1.5:1. */
  isOnSelect?: boolean;
  className?: string;
}) => (
  <span className={cn('relative z-10 flex items-center justify-center', className)}>
    <input
      type="checkbox"
      checked={checked}
      // Mixed has no attribute, only this property.
      ref={input => {
        if (input !== null) input.indeterminate = indeterminate;
      }}
      onChange={event =>
        onCheckedChange(
          event.target.checked,
          event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
        )
      }
      aria-label={label}
      className={cn(
        'absolute inset-0 cursor-pointer appearance-none -outline-offset-2',
        isOnSelect && 'focus-visible:outline-ink',
      )}
    />
    <span
      aria-hidden
      className={cn(
        'pointer-events-none flex size-3.25 items-center justify-center border text-signal-ink',
        (() => {
          if (checked || indeterminate) return 'border-signal bg-signal';
          return isOnSelect ? 'border-ink/50' : 'border-paper-faint';
        })(),
      )}
    >
      {indeterminate ? (
        <MinusIcon size={9} weight="bold" />
      ) : (
        checked && <CheckIcon size={9} weight="bold" />
      )}
    </span>
  </span>
);
