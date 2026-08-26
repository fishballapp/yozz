import { AlertDialog } from '@base-ui/react/alert-dialog';
import { type ReactElement, useState } from 'react';
import { Button } from './Button';

/**
 * The one destructive-confirmation shape: a floating `--ink-raised` sheet with a hairline, the
 * headline step for its question, dim prose for what happens, Cancel then the danger action.
 * Controlled so the sheet stays up while the action runs and closes only once it has settled —
 * a page that navigates away on success never sees it again, and one that fails shows its own
 * error where the trigger was.
 */
export const ConfirmDialog = ({
  trigger,
  triggerLabel,
  title,
  description,
  confirmLabel,
  busyLabel,
  onConfirm,
}: {
  /** The button that opens it, without children; `triggerLabel` is its text. */
  trigger: ReactElement;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  onConfirm: () => Promise<void>;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialog.Trigger render={trigger}>{triggerLabel}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-ink/70 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <AlertDialog.Popup className="w-[min(100%,24rem)] border border-rule bg-ink-raised p-5 outline-none">
            <AlertDialog.Title className="text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
              {title}
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-3 text-base leading-relaxed text-paper-dim">
              {description}
            </AlertDialog.Description>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <AlertDialog.Close render={<Button variant="ghost" disabled={isBusy} />}>
                Cancel
              </AlertDialog.Close>
              <Button
                variant="danger"
                disabled={isBusy}
                onClick={() => {
                  void (async () => {
                    setIsBusy(true);
                    try {
                      await onConfirm();
                    } finally {
                      setIsBusy(false);
                      setIsOpen(false);
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
