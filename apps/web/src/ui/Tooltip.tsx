import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

/** Mounted once at the root: tooltips next to each other open without a second wait. */
export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <BaseTooltip.Provider delay={OPEN_DELAY_MS}>{children}</BaseTooltip.Provider>
);

const OPEN_DELAY_MS = 400;

/**
 * The visible name of a control that is only an icon. It opens on hover and keyboard focus, never
 * on touch, so it may only repeat the control's `aria-label`, never carry something new.
 */
export const Tooltip = ({
  label,
  side = 'bottom',
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** The control itself: one element that takes a ref and spreads its props. */
  children: ReactElement<Record<string, unknown>>;
}) => (
  // Escape closes the tooltip and carries on: inside a dialog the same press must close the
  // dialog, not be spent on a label.
  <BaseTooltip.Root
    onOpenChange={(_isOpen, details) => {
      if (details.reason === 'escape-key') details.allowPropagation();
    }}
  >
    <BaseTooltip.Trigger delay={OPEN_DELAY_MS} render={children} />
    <BaseTooltip.Portal>
      {/* Above the toasts (60): a toast's own close button has a tooltip. */}
      <BaseTooltip.Positioner side={side} sideOffset={6} className="z-[70]">
        <BaseTooltip.Popup className="border border-rule bg-ink-hover px-2 py-1 text-2xs text-paper transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0">
          {label}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  </BaseTooltip.Root>
);
