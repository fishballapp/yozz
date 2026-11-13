import { Toast } from '@base-ui/react/toast';
import { XIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { Button } from './Button';

/**
 * The one transient report line, for an answer that outlives what asked for it: a send its
 * composer, a refused move its row. The manager is created outside React so anything can queue one.
 */
export const toast = Toast.createToastManager<ToastData>();

/** What a toast carries beyond Base UI's own fields. */
type ToastData = {
  /** Which thing the title is about, such as a subject: quieter, after the title, cut to fit. */
  readonly detail?: string;
};

/** A problem waits to be read: no timeout, announced `high`, so it carries the close. */
export const reportProblem = (title: string, description: string) => {
  toast.add({ title, description, timeout: 0, priority: 'high' });
};

/**
 * Something done that can still be taken back ("Archived", "Undo"): it leaves on its own, and the
 * action leaves with it. `detail` names what it was done to, since the screen has already moved on.
 */
export const reportDone = (
  title: string,
  action: { label: string; onAction: () => void },
  detail?: string,
) => {
  const id = toast.add({
    title,
    ...(detail === undefined ? {} : { data: { detail } }),
    timeout: DONE_TIMEOUT_MS,
    actionProps: {
      children: action.label,
      onClick: () => {
        toast.close(id);
        action.onAction();
      },
    },
  });
};

/** Long enough to read the title, find what it names and reach the action. */
const DONE_TIMEOUT_MS = 10_000;

export const Toasts = () => (
  <Toast.Provider toastManager={toast}>
    <Toast.Portal>
      {/* Above the composer's own layer: a send reports as the dialog that started it is still
          animating out. On a phone it spans the app's gutters, so it sits centred; from `lg` it is
          right-aligned on the same gutter, so the stack hangs off the edge the app is ruled to. */}
      <Toast.Viewport className="fixed inset-x-3 bottom-3 z-[60] flex flex-col items-end gap-1.5 lg:left-auto lg:w-84">
        <ToastList />
      </Toast.Viewport>
    </Toast.Portal>
  </Toast.Provider>
);

const ToastList = () => {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map(item => {
    const hasAction = item.actionProps !== undefined;
    // With nothing to read between them, the action sits on the title's own line.
    const isActionInline = hasAction && item.description === undefined;
    const hasBody = item.description !== undefined;
    // Only a toast that waits for you (`timeout: 0`) offers the way out.
    const isSticky = item.timeout === 0;
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className="w-full max-w-full border border-rule lg:w-fit bg-ink-raised transition-[opacity,translate] duration-200 ease-out data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0"
      >
        <Toast.Content className="flex flex-col">
          {/* The state, in the register this app reports machine facts in, and a fixed `control-sm`
              bar so the label and the close button share a centre line whatever follows them. */}
          <div
            className={cn(
              // `control-sm` on a pointer, the 44px floor on a phone.
              'flex h-11 shrink-0 items-center gap-4 lg:h-7',
              isSticky || isActionInline ? 'pr-1 pl-3' : 'px-3',
              hasBody && 'border-b border-rule-soft',
            )}
          >
            {/* One title for assistive technology, in two voices: the state, then what it is about. */}
            <Toast.Title className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="label-rule truncate text-paper">{item.title}</span>
              {item.data?.detail !== undefined && (
                <span dir="auto" className="min-w-0 flex-1 truncate text-base text-paper-dim">
                  {item.data.detail}
                </span>
              )}
            </Toast.Title>
            {isActionInline && (
              <Toast.Action
                render={<Button variant="ghost" size="sm" className="h-11 text-paper lg:h-7" />}
              />
            )}
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
          {hasAction && !isActionInline && (
            <div className="flex justify-end px-3 pb-2.5">
              <Toast.Action render={<Button variant="secondary" size="sm" />} />
            </div>
          )}
        </Toast.Content>
      </Toast.Root>
    );
  });
};
