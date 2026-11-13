import { CaretLeftIcon } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import type { ReactNode } from 'react';
import { keepCompose } from '../../compose/intent';
import { Tooltip } from '../../ui/Tooltip';

/** Where the pane's back link goes: the list, unless the pane sits under another pane. */
export type PaneBack = { readonly label: string; readonly to: '/settings' | '/settings/account' };

const SETTINGS_LIST: PaneBack = { label: 'Settings', to: '/settings' };

/**
 * The right half of Settings: what the selected row is, then its sections. Below `lg` the pane is the
 * whole screen and the app bar above it carries the way back and the page's title (the route's
 * `staticData.title`), so the pane shows only its subline there; the title stays for screen readers.
 * From `lg` the title is on the pane, and a sub-page's caret leads back to the pane it sits under.
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
    <header className={cn('flex items-start lg:mb-8', subline === undefined ? 'mb-0' : 'mb-6')}>
      {/* The list sits beside a top-level pane on a wide screen, so only a sub-page has a way back here. */}
      {back.to !== SETTINGS_LIST.to && (
        <Tooltip label={`Back to ${back.label}`}>
          <Link
            to={back.to}
            search={keepCompose}
            aria-label={`Back to ${back.label}`}
            // 44px to the pointer, centred on the title's first line; the caret sits on the column edge.
            className="-my-2.5 -mr-1 -ml-3.5 hidden size-11 shrink-0 items-center justify-center text-paper-dim transition-colors hover:text-paper lg:flex"
          >
            <CaretLeftIcon size={16} />
          </Link>
        </Tooltip>
      )}
      <div className="min-w-0">
        <h2 className="text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper max-lg:sr-only">
          {title}
        </h2>
        {subline !== undefined && <p className="text-base text-paper-dim lg:mt-1.5">{subline}</p>}
      </div>
    </header>
    {children}
  </>
);
