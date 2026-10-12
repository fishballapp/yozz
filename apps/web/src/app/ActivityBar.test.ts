import { describe, expect, it } from 'vitest';
import { barAt, nextShowIn } from './ActivityBar';

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
