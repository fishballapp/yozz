import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { keepCompose } from '../../compose/intent';
import { buttonClass } from '../../ui/Button';

/** Where the phone's back link goes: the list, unless the pane sits under another pane. */
export type PaneBack = { readonly label: string; readonly to: '/settings' | '/settings/account' };

const SETTINGS_LIST: PaneBack = { label: 'Settings', to: '/settings' };

/**
 * The right half of Settings: what the selected row is, then its sections. On a phone the pane is
 * the whole screen, so it carries the way back; a sub-page's way back shows at every width.
 */
export const SettingsPane = ({
  title,
  subline,
  back = SETTINGS_LIST,
  children,
}: {
  title: ReactNode;
  /** One line on what this is, under the title. */
  subline?: ReactNode;
  back?: PaneBack;
  children: ReactNode;
}) => (
  <>
    <Link
      to={back.to}
      search={keepCompose}
      className={cn(
        buttonClass({ variant: 'ghost', size: 'sm' }),
        '-ml-2.5 mb-4',
        // The list sits beside a top-level pane on a wide screen; it cannot lead back from a sub-page.
        back.to === SETTINGS_LIST.to && 'lg:hidden',
      )}
    >
      <CaretLeftIcon size={12} />
      {back.label}
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
