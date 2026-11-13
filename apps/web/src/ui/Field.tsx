import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { type ComponentPropsWithRef, type ReactNode, useState } from 'react';
import { Tooltip } from './Tooltip';

/** Plain label-associated native controls; anything with real behaviour goes through Base UI. Wells, not boxes. */

/**
 * The underline is the edge that says "this is a field", so it is `--paper-faint` (5.8:1), not a
 * hairline; focus doubles it with an inset shadow, so nothing moves. 16px below `lg` because iOS
 * zooms the page on focusing anything smaller.
 */
const control =
  'w-full px-2.5 py-2 text-[16px]/6 text-paper outline-none transition-colors placeholder:text-paper-faint border-b border-paper-faint hover:border-paper-dim focus:border-signal focus:shadow-[inset_0_-1px_0_var(--signal)] lg:text-base';

/** The ground the field sits on: a well is one step off it, down from the page and up from a sunken pane. */
type Ground = 'page' | 'sunken';

const WELL: Record<Ground, string> = {
  page: 'bg-ink-sunken',
  sunken: 'bg-ink-raised',
};

type InputProps = ComponentPropsWithRef<'input'> & { ground?: Ground };

export const Input = ({ className, ground = 'page', ...props }: InputProps) => (
  <input className={cn(control, WELL[ground], className)} {...props} />
);

export const Textarea = ({
  className,
  ground = 'page',
  ...props
}: ComponentPropsWithRef<'textarea'> & { ground?: Ground }) => (
  <textarea
    className={cn(control, WELL[ground], 'resize-none leading-relaxed', className)}
    {...props}
  />
);

/** A password that can be read back before it is submitted; it starts masked. */
export const PasswordInput = ({ className, ...props }: Omit<InputProps, 'type'>) => {
  const [isShown, setIsShown] = useState(false);
  const label = isShown ? 'Hide password' : 'Show password';
  return (
    <div className="relative">
      <Input type={isShown ? 'text' : 'password'} className={cn('pr-11', className)} {...props} />
      <Tooltip label={label}>
        <button
          type="button"
          aria-label={label}
          aria-pressed={isShown}
          onClick={() => setIsShown(previous => !previous)}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-paper-faint transition-colors hover:text-paper"
        >
          {isShown ? <EyeSlashIcon size={15} /> : <EyeIcon size={15} />}
        </button>
      </Tooltip>
    </div>
  );
};

type HintTone = 'quiet' | 'caution';

const HINT: Record<HintTone, string> = {
  quiet: 'text-2xs text-paper-faint',
  // A fact the person must not miss (it can't be undone) is set as body copy, not as a caption.
  caution: 'text-base text-paper-dim',
};

export const FieldHint = ({
  tone = 'quiet',
  className,
  ...props
}: ComponentPropsWithRef<'p'> & { tone?: HintTone }) => (
  <p className={cn(HINT[tone], className)} {...props} />
);

/**
 * With `htmlFor`, the status line's id is `<htmlFor>-status` and the hint's `<htmlFor>-hint`, for
 * the control's `aria-describedby`.
 */
export const FieldRow = ({
  label,
  htmlFor,
  status,
  isStatusMet = false,
  hint,
  hintTone,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  /**
   * A live line under the control ("7 characters · 12 minimum"). Pass `null` while there is
   * nothing to say: the line keeps its height, so the form doesn't jump when it speaks.
   */
  status?: ReactNode;
  /** The status reports a requirement now satisfied. */
  isStatusMet?: boolean;
  hint?: ReactNode;
  hintTone?: HintTone;
  children: ReactNode;
}) => (
  <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="label-rule block">
      {label}
    </label>
    {children}
    {status !== undefined && (
      <p
        id={htmlFor === undefined ? undefined : `${htmlFor}-status`}
        aria-live="polite"
        className={cn('min-h-4 text-2xs', isStatusMet ? 'text-paper' : 'text-paper-dim')}
      >
        {status}
      </p>
    )}
    {hint !== undefined && (
      <FieldHint id={htmlFor === undefined ? undefined : `${htmlFor}-hint`} tone={hintTone}>
        {hint}
      </FieldHint>
    )}
  </div>
);
