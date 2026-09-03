import { cn } from '@fishballapps/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

/** Square by design: nothing in Ink & Rule has a corner radius. */
/**
 * Disabled is a colour change, never `opacity` (the signal fill at 40% put its label at 2.2:1),
 * and drops the fill rather than borrowing `--ink-hover`, which is `secondary`'s ground.
 */
/** Exported because some buttons are links a middle-click must open in a tab. */
export const buttonClass = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-offset-0 transition-colors disabled:pointer-events-none disabled:bg-transparent disabled:text-paper-faint',
  {
    variants: {
      variant: {
        // Primary keeps a ground when disabled, or the one primary action turns into a caption.
        primary: 'bg-signal text-signal-ink hover:bg-signal/85 disabled:bg-ink-sunken',
        secondary: 'bg-ink-hover text-paper hover:bg-rule',
        ghost: 'text-paper-dim hover:bg-ink-hover hover:text-paper',
        // Paper on `danger` measures 3.08:1 and misses AA; `ink` measures 5.38:1.
        danger: 'text-danger hover:bg-danger hover:text-ink',
      },
      size: {
        sm: 'h-7 px-2.5 text-2xs',
        md: 'h-8 px-3 text-base',
        icon: 'size-7',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonClass>;

export const Button = ({ className, variant, size, type = 'button', ...props }: ButtonProps) => (
  <button type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />
);
