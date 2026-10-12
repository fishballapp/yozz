import { describe, expect, it } from 'vitest';
import { check, NO_SELECTION, type Selection, toggleAll } from './selection';

const ORDER = ['a', 'b', 'c', 'd', 'e'];
const ticked = (selection: Selection) => ORDER.filter(id => selection.ids.has(id));

describe('check', () => {
  it('ticks the range from the last box clicked on a Shift-click, either way up', () => {
    const anchored = check(NO_SELECTION, ORDER, 'b', true, false);
    expect(ticked(check(anchored, ORDER, 'd', true, true))).toEqual(['b', 'c', 'd']);
    expect(
      ticked(check(check(NO_SELECTION, ORDER, 'd', true, false), ORDER, 'b', true, true)),
    ).toEqual(['b', 'c', 'd']);
  });

  it('unticks a range the same way', () => {
    const all = toggleAll(NO_SELECTION, ORDER);
    const anchored = check(all, ORDER, 'b', false, false);
    expect(ticked(check(anchored, ORDER, 'd', false, true))).toEqual(['a', 'e']);
  });

  it('ticks one row on a Shift-click with no anchor in the list', () => {
    const anchored = check(NO_SELECTION, ['gone', ...ORDER], 'gone', true, false);
    expect(ticked(check(anchored, ORDER, 'c', true, true))).toEqual(['c']);
  });

  it('leaves select mode with the last tick, and not before', () => {
    const selecting = { ...NO_SELECTION, isSelecting: true };
    const one = check(selecting, ORDER, 'a', true, false);
    expect(one.isSelecting).toBe(true);
    expect(check(one, ORDER, 'a', false, false).isSelecting).toBe(false);
  });

  it('drops a ticked row a sync took away', () => {
    const one = check(NO_SELECTION, ['gone', ...ORDER], 'gone', true, false);
    expect(check(one, ORDER, 'a', true, false).ids).toEqual(new Set(['a']));
  });
});

describe('toggleAll', () => {
  it('ticks everything when nothing is ticked', () => {
    expect(ticked(toggleAll(NO_SELECTION, ORDER))).toEqual(ORDER);
  });

  it('clears a partial selection rather than completing it, and leaves select mode', () => {
    const some = check({ ...NO_SELECTION, isSelecting: true }, ORDER, 'c', true, false);
    expect(toggleAll(some, ORDER)).toEqual(NO_SELECTION);
  });
});
