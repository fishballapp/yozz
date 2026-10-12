import { AlertDialog } from '@base-ui/react/alert-dialog';
import { type ReactElement, type ReactNode, useState } from 'react';
import { Button } from './Button';

/**
 * The one shape for a question the app must have answered before it acts. On the question layer
 * (DESIGN.md, "the stack"), forcing its own backdrop, which Base UI drops for a nested dialog.
 * Controlled while the action runs, and it closes only when `onConfirm` resolves. A rejected
 * `onConfirm` leaves it open, so the caller can say why in `children` and let the person retry.
 */
export const ConfirmDialog = ({
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  isConfirmEnabled = true,
  busyLabel,
  onConfirm,
  ...mode
}: {
  title: string;
  description: string;
  /** Between the prose and the buttons, such as a "don't ask" tick. */
  children?: ReactNode;
  confirmLabel: string;
  /** What the way out is called when it is a decision of its own, such as Skip. */
  cancelLabel?: string;
  /** `danger` for a destructive question, `primary` for one that merely wants a decision. */
  confirmVariant?: 'danger' | 'primary';
  /** False keeps Confirm disabled, and Enter with it, until something in `children` is answered. */
  isConfirmEnabled?: boolean;
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

  const trigger = (() => {
    if (mode.trigger === undefined) return null;
    if (mode.triggerLabel === undefined) return <AlertDialog.Trigger render={mode.trigger} />;
    return <AlertDialog.Trigger render={mode.trigger}>{mode.triggerLabel}</AlertDialog.Trigger>;
  })();

  /** Runs the action; closes only once it resolves. Enter in the form and the button both come here. */
  const confirm = () => {
    if (isBusy || !isConfirmEnabled) return;
    void (async () => {
      setIsBusy(true);
      try {
        await onConfirm();
        setOpen(false);
      } catch {
        // Still open: the caller shows the reason in `children`.
      } finally {
        setIsBusy(false);
      }
    })();
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setOpen}>
      {trigger}
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
            {/* A form so Enter in any of the children confirms, the same as the button. */}
            <form
              onSubmit={event => {
                event.preventDefault();
                confirm();
              }}
            >
              <AlertDialog.Title className="text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
                {title}
              </AlertDialog.Title>
              <AlertDialog.Description className="mt-3 text-base leading-relaxed text-paper-dim">
                {description}
              </AlertDialog.Description>
              {children}
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <AlertDialog.Close render={<Button variant="ghost" disabled={isBusy} />}>
                  {cancelLabel}
                </AlertDialog.Close>
                <Button
                  type="submit"
                  variant={confirmVariant}
                  disabled={isBusy || !isConfirmEnabled}
                >
                  {isBusy ? busyLabel : confirmLabel}
                </Button>
              </div>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
};
