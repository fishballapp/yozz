// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { createActivityTracker } from '../relay/activity';
import { ActivityBar, barAt, nextShowIn } from './ActivityBar';

const { activity } = vi.hoisted(() => ({ activity: { tracker: null as unknown } }));
vi.mock('../store/MailProvider', () => ({ useMail: () => ({ activity: activity.tracker }) }));

const read = (startedAt: number) => ({ effect: 'read', priority: 'user', startedAt }) as const;
const write = (startedAt: number) => ({ effect: 'write', priority: 'user', startedAt }) as const;
const prefetch = (startedAt: number) =>
  ({ effect: 'read', priority: 'background', startedAt }) as const;

describe('barAt', () => {
  it('stays off for work someone asked for until it is not instant', () => {
    expect(barAt([read(0)], 199)).toBe('off');
    expect(barAt([read(0)], 200)).toBe('read');
  });

  it('shows work nobody asked for only once it is slow', () => {
    expect(barAt([prefetch(0)], 2999)).toBe('off');
    expect(barAt([prefetch(0)], 3000)).toBe('read');
  });

  it('turns to a write while one a reload would lose is shown', () => {
    expect(barAt([read(0), write(0)], 500)).toBe('write');
    // Not yet past its own delay, the write does not colour a bar it is not on.
    expect(barAt([read(0), write(400)], 500)).toBe('read');
  });

  it('is off with nothing in flight', () => {
    expect(barAt([], 1000)).toBe('off');
  });
});

describe('nextShowIn', () => {
  it('waits for the soonest piece of work still under its delay', () => {
    expect(nextShowIn([read(0), prefetch(0)], 100)).toBe(100);
    expect(nextShowIn([read(0), prefetch(0)], 500)).toBe(2500);
    expect(nextShowIn([read(0)], 500)).toBeNull();
  });
});

describe('ActivityBar', () => {
  it("takes many tasks settling between two of the browser's tasks without React #185", async () => {
    const tracker = createActivityTracker();
    activity.tracker = tracker;
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<ActivityBar />));

    // Each change re-renders synchronously (`useSyncExternalStore`); only microtasks run between
    // them, as when a live connection's queue drains. A state set in each of those commits nests.
    const thrown: unknown[] = [];
    for (let task = 0; task < 120; task += 1) {
      try {
        const end = tracker.begin({ effect: 'write', priority: 'user' });
        await Promise.resolve();
        end();
        await Promise.resolve();
      } catch (error) {
        thrown.push(error);
      }
    }
    expect(thrown).toEqual([]);

    // And the bar still shows work that outlasts its delay.
    const end = tracker.begin({ effect: 'write', priority: 'user' });
    const bar = host.firstElementChild;
    await vi.waitFor(() => expect(bar?.className).toContain('opacity-100'), { timeout: 1000 });
    end();
    await vi.waitFor(() => expect(bar?.className).toContain('opacity-0'));
    await act(async () => root.unmount());
  });
});
