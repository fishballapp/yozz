import { AlertDialog } from '@base-ui/react/alert-dialog';
import { type ReactElement, type ReactNode, useState } from 'react';
import { Button } from './Button';

/**
 * The one shape for a question the app must have answered before it acts. On the question layer
 * (DESIGN.md, "the stack"), forcing its own backdrop, which Base UI drops for a nested dialog.
 * Controlled while the action runs, so it closes only once the action settles.
 */
export const ConfirmDialog = ({
  title,
  description,
  children,
  confirmLabel,
  confirmVariant = 'danger',
  busyLabel,
  onConfirm,
  ...mode
}: {
  title: string;
  description: string;
  /** Between the prose and the buttons, such as a "don't ask" tick. */
  children?: ReactNode;
  confirmLabel: string;
  /** `danger` for a destructive question, `primary` for one that merely wants a decision. */
  confirmVariant?: 'danger' | 'primary';
  busyLabel: string;
  onConfirm: () => Promise<void>;
} & (
  | {
      /** The control that opens it. */
      trigger: ReactElement;
      /** Omit it and the trigger keeps whatever it already renders. */
      triggerLabel?: string;
      open?: never;
      onOpenChange?: never;
    }
  /** No trigger, for a question something other than a click asks. */
  | {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      trigger?: never;
      triggerLabel?: never;
    }
)) => {
  const [isOpenHere, setIsOpenHere] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const isOpen = mode.open ?? isOpenHere;
  const setOpen = (next: boolean) => {
    setIsOpenHere(next);
    mode.onOpenChange?.(next);
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setOpen}>
      {mode.trigger === undefined ? null : mode.triggerLabel === undefined ? (
        <AlertDialog.Trigger render={mode.trigger} />
      ) : (
        <AlertDialog.Trigger render={mode.trigger}>{mode.triggerLabel}</AlertDialog.Trigger>
      )}
      <AlertDialog.Portal>
        {/*
          This sheet interrupts whatever asked the question, so it sits ABOVE the app's dialog
          layer (backdrop 40, popup 50) and above the toast (60). At 40 its own scrim painted
          UNDER the composer that opened it, which left the composer at full brightness behind
          the question.

          `forceRender` because Base UI drops a nested dialog's backdrop by default, reasoning
          that the parent already has one — true of the pixels and wrong here: the parent's
          scrim dims the app, and this one has to dim the parent.
        */}
        <AlertDialog.Backdrop
          forceRender
          className="fixed inset-0 z-[70] bg-ink/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <AlertDialog.Viewport className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          {/*
            The same 150ms entrance the composer has, because the backdrop already faded and the
            sheet did not — and the eye tracks the sheet, so the pair read as no fade at all.
            `prefers-reduced-motion` is answered globally in `styles/global.css`.

            The transition names `translate`, not `transform`: Tailwind v4's `translate-y-1` sets
            the `translate` property, so an arbitrary `transition-[…,transform]` does not cover it
            and the rise lands in one frame with only the opacity animating. (`transition-transform`
            spells out all four, which is why the mobile rail's slide was never affected.)
          */}
          <AlertDialog.Popup className="w-[min(100%,24rem)] border border-rule bg-ink-raised p-5 outline-none transition-[opacity,translate] duration-150 data-[ending-style]:translate-y-1 data-[ending-style]:opacity-0 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0">
            <AlertDialog.Title className="text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-base leading-relaxed text-paper-dim">
              {description}
            </AlertDialog.Description>
            {children}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <AlertDialog.Close render={<Button variant="ghost" disabled={isBusy} />}>
                Cancel
              </AlertDialog.Close>
              <Button
                variant={confirmVariant}
                disabled={isBusy}
                onClick={() => {
                  void (async () => {
                    setIsBusy(true);
                    try {
                      await onConfirm();
                    } finally {
                      setIsBusy(false);
                      setOpen(false);
                    }
                  })();
                }}
              >
                {isBusy ? busyLabel : confirmLabel}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
