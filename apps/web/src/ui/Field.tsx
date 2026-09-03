import { cn } from '@fishballapps/cn';
import type { ComponentPropsWithRef, ReactNode } from 'react';

/** Plain label-associated native controls; anything with real behaviour goes through Base UI. Wells, not boxes. */

const control =
  'w-full bg-ink-sunken px-2.5 py-2 text-base text-paper outline-none transition-colors placeholder:text-paper-faint border-b border-rule hover:border-paper-faint focus:border-signal';

export const Input = ({ className, ...props }: ComponentPropsWithRef<'input'>) => (
  <input className={cn(control, className)} {...props} />
);

export const Textarea = ({ className, ...props }: ComponentPropsWithRef<'textarea'>) => (
  <textarea className={cn(control, 'resize-none leading-relaxed', className)} {...props} />
);

export const FieldRow = ({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) => (
  <div className="space-y-1.5">
    <label htmlFor={htmlFor} className="label-rule block">
      {label}
    </label>
    {children}
    {hint !== undefined && <p className="text-2xs text-paper-faint">{hint}</p>}
  </div>
);
