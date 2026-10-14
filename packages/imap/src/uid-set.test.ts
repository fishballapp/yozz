import { describe, expect, it } from 'vitest';
import { uidSets } from './uid-set.ts';

describe('uidSets', () => {
  it('writes runs as ranges, in order, once each', () => {
    expect(uidSets([9, 3, 4, 5, 12, 4, 13])).toEqual(['3:5,9,12:13']);
  });

  it('is empty for no uids', () => {
    expect(uidSets([])).toEqual([]);
  });

  it('splits a set that would pass the length, never inside a range', () => {
    expect(uidSets([1, 2, 3, 10, 20, 30], 8)).toEqual(['1:3,10', '20,30']);
    const scattered = Array.from({ length: 2000 }, (_, index) => 1_000_000 + index * 2);
    const sets = uidSets(scattered);
    expect(sets.length).toBeGreaterThan(1);
    expect(sets.every(set => set.length <= 4096)).toBe(true);
    expect(sets.flatMap(set => set.split(',').map(Number))).toEqual(scattered);
  });
});
