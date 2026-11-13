// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { type SetupStep, SetupSteps } from './SetupSteps';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: (() => Promise<void>)[] = [];

const mount = async (current: SetupStep) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<SetupSteps current={current} />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

const stepsOf = (page: HTMLElement) => [...page.querySelectorAll('li[data-state]')];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

describe('SetupSteps', () => {
  it('ticks the finished steps in signal, lights the current one and numbers the rest', async () => {
    const page = await mount(2);
    const [email, login, address] = stepsOf(page);

    expect(email?.getAttribute('data-state')).toBe('done');
    expect(email?.querySelector('svg')?.getAttribute('class')).toContain('text-signal');
    expect(email?.textContent).toBe('Email');

    expect(login?.getAttribute('aria-current')).toBe('step');
    expect(login?.className).toContain('font-medium');
    expect(login?.className).toContain('text-paper');
    expect(login?.textContent).toBe('2Login');

    expect(address?.getAttribute('data-state')).toBe('pending');
    expect(address?.querySelector('svg')).toBeNull();
    expect(address?.textContent).toBe('3Address');
  });

  it('stays on one line', async () => {
    const page = await mount(1);
    expect(page.querySelector('ol')?.className).toContain('whitespace-nowrap');
    expect(page.querySelector('ol')?.className).not.toContain('flex-wrap');
  });
});
