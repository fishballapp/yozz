import { describe, expect, it, vi } from 'vitest';
import { createActivityTracker, isUnsavedWork } from './activity';

describe('createActivityTracker', () => {
  it('lists work from begin until it ends, with when it began, and ends it only once', () => {
    const tracker = createActivityTracker(() => 5);
    const listener = vi.fn();
    tracker.subscribe(listener);
    const endRead = tracker.begin({ effect: 'read', priority: 'user' });
    const endWrite = tracker.begin({ effect: 'write', priority: 'user' });
    expect(tracker.snapshot()).toHaveLength(2);

    endRead();
    endRead();
    expect(tracker.snapshot()).toEqual([{ effect: 'write', priority: 'user', startedAt: 5 }]);
    expect(listener).toHaveBeenCalledTimes(3);
    endWrite();
    expect(tracker.snapshot()).toEqual([]);
  });

  it('ends the entry it began, not an equal one', () => {
    const tracker = createActivityTracker();
    const endFirst = tracker.begin({ effect: 'read', priority: 'user' });
    tracker.begin({ effect: 'read', priority: 'user' });
    endFirst();
    expect(tracker.snapshot()).toHaveLength(1);
  });

  it('hands out the same snapshot until the list changes', () => {
    const tracker = createActivityTracker();
    tracker.begin({ effect: 'read', priority: 'user' });
    expect(tracker.snapshot()).toBe(tracker.snapshot());
  });
});

describe('isUnsavedWork', () => {
  it('is a write someone asked for, and nothing else', () => {
    expect(isUnsavedWork({ effect: 'write', priority: 'user' })).toBe(true);
    expect(isUnsavedWork({ effect: 'write', priority: 'background' })).toBe(false);
    expect(isUnsavedWork({ effect: 'read', priority: 'user' })).toBe(false);
  });
});
