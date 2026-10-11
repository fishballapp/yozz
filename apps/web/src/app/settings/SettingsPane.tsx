import { cn } from '@fishballapps/cn';
import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { keepCompose } from '../../compose/intent';
import { buttonClass } from '../../ui/Button';

/**
 * The right half of Settings: what the selected row is, then its sections. On a phone the pane is
 * the whole screen, so it carries the way back to the list.
 */
export const SettingsPane = ({
  title,
  subline,
  children,
}: {
  title: ReactNode;
  /** One line on what this is, under the title. */
  subline?: ReactNode;
  children: ReactNode;
}) => (
  <>
    <Link
      to="/settings"
      search={keepCompose}
      className={cn(buttonClass({ variant: 'ghost', size: 'sm' }), '-ml-2.5 mb-4 lg:hidden')}
    >
      <CaretLeftIcon size={12} />
      Settings
    </Link>
    <header className="mb-8">
      <h2 className="min-w-0 text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
        {title}
      </h2>
      {subline !== undefined && <p className="mt-1.5 text-base text-paper-dim">{subline}</p>}
    </header>
    {children}
  </>
);
