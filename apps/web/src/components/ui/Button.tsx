import { cn } from '@fishballapps/cn';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

/**
 * Square by design. Nothing in Ink & Rule has a corner radius, so the button reads as a cut block
 * of the surface rather than a pill sitting on top of it.
 */
/**
 * Disabled is a colour change, never `opacity`. Fading a filled button fades its label with its
 * ground, so the pair keeps its ratio to each other and loses it to the page — the signal fill at
 * 40% put its label at 2.2:1.
 *
 * It removes emphasis rather than adding any: disabled drops the fill entirely instead of taking
 * a neutral one, because `--ink-hover` is already the `secondary` ground and a disabled control
 * that borrows it reads as an ordinary enabled button. `--paper-faint` on any app ground is >=4.96:1.
 */
/**
 * Exported because some buttons are LINKS — compose, "back to mail", "connect an account" all
 * change the URL, so they must be anchors a middle-click can open in a tab. They wear this rather
 * than a hand-copied approximation of it, which is how the third copy of a primary block drifts.
 */
export const buttonClass = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-offset-0 transition-colors disabled:pointer-events-none disabled:bg-transparent disabled:text-paper-faint',
  {
    variants: {
      variant: {
        // Primary keeps a ground when disabled: dropping the fill entirely is right for a control
        // that never had one, but it turns the surface's ONE primary action into a caption.
        primary: 'bg-signal text-signal-ink hover:bg-signal/85 disabled:bg-ink-sunken',
        secondary: 'bg-ink-hover text-paper hover:bg-rule',
        ghost: 'text-paper-dim hover:bg-ink-hover hover:text-paper',
        danger: 'text-danger hover:bg-danger hover:text-paper',
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
