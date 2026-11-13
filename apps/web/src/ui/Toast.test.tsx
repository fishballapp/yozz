// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { reportDone, Toasts, toast } from './Toast';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const host = document.createElement('div');
const root = createRoot(host);

afterEach(async () => {
  await act(async () => {
    toast.close();
    root.render(null);
  });
});

describe('an undo toast', () => {
  it('spans a phone between the gutters and hangs off the right edge from `lg`', async () => {
    await act(async () => root.render(<Toasts />));
    await act(async () => reportDone('Archived', { label: 'Undo', onAction: () => {} }, 'Lunch'));
    const viewport = document.querySelector<HTMLElement>('[class*="z-[60]"]');
    expect(viewport?.className).toContain('inset-x-3');
    expect(viewport?.className).toContain('lg:left-auto');
    const item = [...document.querySelectorAll<HTMLElement>('[class*="border-rule"]')].find(
      ({ textContent }) => textContent?.includes('Archived'),
    );
    expect(item?.className).toContain('w-full');
    expect(item?.className).toContain('lg:w-fit');
  });
});
