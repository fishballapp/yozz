// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { PasswordInput } from './Field';
import { reportDone, Toasts } from './Toast';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.useRealTimers();
});

const mount = async (node: ReactNode) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(
    candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent) === name,
  );
  if (found === undefined) throw new Error(`no button named ${name}`);
  return found;
};

describe('PasswordInput', () => {
  it('starts masked and shows the value on request', async () => {
    await mount(<PasswordInput aria-label="Password" defaultValue="correct horse" />);
    const input = document.querySelector('input');
    expect(input?.type).toBe('password');
    await act(async () => button('Show password').click());
    expect(input?.type).toBe('text');
    expect(input?.value).toBe('correct horse');
    await act(async () => button('Hide password').click());
    expect(input?.type).toBe('password');
  });
});

describe('Button size="icon"', () => {
  it('shows its aria-label as a tooltip on keyboard focus', async () => {
    vi.useFakeTimers();
    await mount(
      <Button size="icon" aria-label="Archive">
        ×
      </Button>,
    );
    expect(document.body.textContent).not.toContain('Archive');
    await act(async () => {
      button('Archive').focus();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(document.body.textContent).toContain('Archive');
  });
});

describe('reportDone', () => {
  it('runs the action once and takes the toast away with it', async () => {
    vi.useFakeTimers();
    const onUndo = vi.fn();
    await mount(<Toasts />);
    await act(async () => reportDone('Archived', { label: 'Undo', onAction: onUndo }));
    expect(document.body.textContent).toContain('Archived');
    await act(async () => {
      button('Undo').click();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('Archived');
  });

  it('leaves on its own after ten seconds', async () => {
    vi.useFakeTimers();
    await mount(<Toasts />);
    await act(async () => reportDone('Archived', { label: 'Undo', onAction: () => {} }));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(document.body.textContent).toContain('Archived');
    await act(async () => vi.advanceTimersByTimeAsync(2500));
    expect(document.body.textContent).not.toContain('Archived');
  });

  it('names what it was done to, after the title', async () => {
    await mount(<Toasts />);
    await act(async () =>
      reportDone('Archived', { label: 'Undo', onAction: () => {} }, 'Contract for review'),
    );
    expect(document.body.textContent).toContain('ArchivedContract for review');
  });
});
