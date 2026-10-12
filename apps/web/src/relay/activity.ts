/**
 * Every piece of mail work in flight, whichever layer started it: the live manager reports each
 * IMAP task, a send reports itself. What is shown and what is warned about is read from this one
 * list, never tracked again on the side.
 */
export type Activity = {
  /** A write changes something on a server; dropping it unfinished loses what the person did. */
  readonly effect: 'read' | 'write';
  /** `user` is work someone is waiting on; `background` keeps the mail fresh unasked. */
  readonly priority: 'user' | 'background';
};

export type ActivityTracker = {
  /** Registers work as started; the function it returns ends it, once, however often it is called. */
  readonly begin: (activity: Activity) => () => void;
  /** The same array until the list changes, as `useSyncExternalStore` needs. */
  readonly snapshot: () => readonly Activity[];
  readonly subscribe: (listener: () => void) => () => void;
};

export const createActivityTracker = (): ActivityTracker => {
  let current: readonly Activity[] = [];
  const listeners = new Set<() => void>();
  const publish = (next: readonly Activity[]) => {
    current = next;
    for (const listener of listeners) listener();
  };

  return {
    begin: activity => {
      // Its own object, so ending it removes this one and not an equal one.
      const entry = { ...activity };
      publish([...current, entry]);
      let isEnded = false;
      return () => {
        if (isEnded) return;
        isEnded = true;
        publish(current.filter(candidate => candidate !== entry));
      };
    },
    snapshot: () => current,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/** Work whose loss a reload would cause: a write someone asked for, still in flight. */
export const isUnsavedWork = ({ effect, priority }: Activity): boolean =>
  effect === 'write' && priority === 'user';
