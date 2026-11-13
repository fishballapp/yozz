import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import type { ButtonHTMLAttributes } from 'react';
import { Tooltip } from './Tooltip';

/**
 * Square by design: nothing in Ink & Rule has a corner radius.
 *
 * Three states must never be confused. An enabled `secondary` is a ring and a `--paper` label; a
 * disabled `primary` is a slab with no ring and a faint label; a `ghost` has no ground at all. A
 * ring therefore means "enabled, press me", and nothing disabled carries one. Disabled is always a
 * colour change, never `opacity`: the signal fill at 40% leaves its label too faint to read.
 */
const DISABLED_BARE = 'disabled:bg-transparent disabled:text-paper-faint disabled:ring-0';
/** A filled button keeps its shape when disabled, or the one action in a row turns into a caption. */
const DISABLED_SLAB = 'disabled:bg-ink-hover disabled:text-paper-faint/60';

/** Exported because some buttons are links a middle-click must open in a tab. */
export const buttonClass = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-offset-0 transition-colors disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: cn('bg-signal text-signal-ink hover:bg-signal/85', DISABLED_SLAB),
        // `--ink-hover` on `--ink` is 1.17:1, so the ring is its boundary: `--paper-faint` at 70%
        // measures 3.38:1 on `--ink` and 3.28:1 on `--ink-raised`, over the 3:1 a boundary needs.
        secondary: cn(
          'bg-ink-hover text-paper ring-1 ring-inset ring-paper-faint/70 hover:bg-rule',
          DISABLED_BARE,
        ),
        ghost: cn('text-paper-dim hover:bg-ink-hover hover:text-paper', DISABLED_BARE),
        // The destructive `secondary`: a resting ring so the red word reads as a button, filling
        // on hover. Paper on `danger` measures 3.08:1 and misses AA; `ink` measures 5.38:1.
        danger: cn(
          'text-danger ring-1 ring-inset ring-danger/70 hover:bg-danger hover:text-ink hover:ring-0',
          DISABLED_BARE,
        ),
        // The destructive `primary`, for the confirm that ends a destructive question.
        dangerFilled: cn('bg-danger text-ink hover:bg-danger/85', DISABLED_SLAB),
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

/** An icon button's `aria-label` is also its tooltip: the pointer has no other way to read it. */
export const Button = ({ className, variant, size, type = 'button', ...props }: ButtonProps) => {
  const button = (
    <button type={type} className={cn(buttonClass({ variant, size }), className)} {...props} />
  );
  const label = props['aria-label'];
  if (size !== 'icon' || label === undefined) return button;
  return <Tooltip label={label}>{button}</Tooltip>;
};

/**
 * A tertiary action as an underlined text link: no ground and no padding, so it starts on the
 * column's edge. `linkClass` is for a router `Link` that should look the same.
 */
export const linkClass =
  'text-left text-base text-paper-dim underline underline-offset-4 transition-colors hover:text-paper disabled:pointer-events-none disabled:text-paper-faint disabled:no-underline';

export const LinkButton = ({
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type={type} className={cn(linkClass, className)} {...props} />
);
