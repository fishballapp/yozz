import { Toast } from '@base-ui/react/toast';
import { cn } from '@fishballapps/cn';
import { XIcon } from '@phosphor-icons/react';
import { Button } from './Button';

/**
 * The app's one transient report line. It exists because a send outlives the form that started
 * it: the composer closes the moment the bytes are frozen, and SMTP, the copy into Sent and the
 * mirror sweep settle after it is gone. A dialog cannot report that, and the status line is one
 * slot shared with sync — so what became of the send says so here and then leaves.
 *
 * The manager is created outside React so anything can queue a toast without being under the
 * provider or holding the hook.
 *
 * **It is a panel in miniature, not a card.** Same parts as every other surface here: a `2xs`
 * mono rule-label in a `1.75rem` bar, a hairline, then prose on the raised plate. No radius, no
 * shadow, and no `--signal` — a toast is none of that token's four jobs, so the words carry the
 * state. It is sized by its content rather than to a column, because "Sent" is one word and a
 * fixed plate around one word is mostly empty plate.
 */
export const toast = Toast.createToastManager();

export const Toasts = () => (
  <Toast.Provider toastManager={toast}>
    <Toast.Portal>
      {/* Above the status line, and above the composer's own layer: a send reports as the dialog
          that started it is still animating out. Right-aligned on the status line's own gutter,
          so the stack hangs off the same edge the app is already ruled to. */}
      <Toast.Viewport className="fixed right-3 bottom-10 z-[60] flex w-[min(100vw-1.5rem,21rem)] flex-col items-end gap-1.5">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
);

const ToastList = () => {
  const { toasts } = Toast.useToastManager();
  return toasts.map(item => {
    const hasBody = item.description !== undefined || item.actionProps !== undefined;
    /**
     * A toast that leaves on its own does not need a button to make it leave — and dropping it
     * takes the whole control column out of the common case, which is what lets "Sent" be the
     * width of the word "Sent". Only a toast that waits for you (`timeout: 0` — every state that
     * reports a problem) offers the way out.
     */
    const isSticky = item.timeout === 0;
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className="w-fit max-w-full border border-rule bg-ink-raised transition-[opacity,translate] duration-200 ease-out data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
      >
        <Toast.Content className="flex flex-col">
          {/* The state, in the register this app reports machine facts in, and a fixed `control-sm`
              bar so the label and the close button share a centre line whatever follows them. */}
          <div
            className={cn(
              // `control-sm` on a pointer, the 44px touch floor on a phone — the same pair every
              // icon button in the app wears, because the bar is sized by the button inside it.
              'flex h-11 shrink-0 items-center gap-4 lg:h-7',
              isSticky ? 'pr-1 pl-3' : 'px-3',
              hasBody && 'border-b border-rule-soft',
            )}
          >
            <Toast.Title className="label-rule flex-1 truncate text-paper" />
            {isSticky && (
              <Toast.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    aria-label="Dismiss"
                  />
                }
              >
                <XIcon size={13} />
              </Toast.Close>
            )}
          </div>
          <Toast.Description className="px-3 py-2 text-base text-paper-dim empty:hidden" />
          {item.actionProps !== undefined && (
            <div className="flex justify-end px-3 pb-2.5">
              <Toast.Action render={<Button variant="secondary" size="sm" />} />
            </div>
          )}
        </Toast.Content>
      </Toast.Root>
    );
  });
};
