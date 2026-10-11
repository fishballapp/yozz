// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

/** Opens the dialog with a field in it, the way Account's password question does. */
const mountOpen = async (onConfirm: () => Promise<void>, isConfirmEnabled = true) => {
  const onOpenChange = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Confirm it’s you"
        description="Say it again."
        confirmLabel="Confirm"
        busyLabel="Working…"
        isConfirmEnabled={isConfirmEnabled}
        onConfirm={onConfirm}
      >
        <input aria-label="Current password" />
      </ConfirmDialog>,
    ),
  );
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { onOpenChange };
};

/** The form around the field: its submit is what Enter in the field does. */
const submitFromField = async () => {
  const form = document.querySelector('input[aria-label="Current password"]')?.closest('form');
  if (form === null || form === undefined) throw new Error('no form around the field');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('ConfirmDialog', () => {
  it('runs its confirm when the form is submitted, the same as the button', async () => {
    const onConfirm = vi.fn(async () => {});
    const { onOpenChange } = await mountOpen(onConfirm);

    await submitFromField();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when its confirm rejects', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('no');
    });
    const { onOpenChange } = await mountOpen(onConfirm);

    await submitFromField();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('does not confirm, by button or by Enter, while it is not enabled', async () => {
    const onConfirm = vi.fn(async () => {});
    await mountOpen(onConfirm, false);

    await submitFromField();
    const confirm = [...document.querySelectorAll('button')].find(
      candidate => candidate.textContent === 'Confirm',
    );
    expect(confirm?.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('gives Cancel type button, so it never submits the form', async () => {
    const onConfirm = vi.fn(async () => {});
    await mountOpen(onConfirm);
    const cancel = [...document.querySelectorAll('button')].find(
      candidate => candidate.textContent === 'Cancel',
    );
    expect(cancel?.getAttribute('type')).toBe('button');
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
