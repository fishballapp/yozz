import { useMemo, useState, useSyncExternalStore } from 'react';

/**
 * Shape survives a reload (pane widths, list layout); content does not. Read in the initialiser,
 * not an effect, so the first frame is the stored one. Every write is guarded: storage can be
 * denied. Dev-only: `localStorage.setItem('yozz:demo','1')` turns on the fixture inbox.
 */
const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The session keeps the preference; the next one starts at the default.
  }
};

/** Total: a denied or missing store is "not demo". */
export const isDemo = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem('yozz:demo') === '1';
  } catch {
    return false;
  }
};

/** `null` is held inside the hook so "never chosen" stays distinct from "equals the default", and the default keeps stepping with the viewport. */
export const useChromePref = <T>(key: string, fallback: T, parse: (raw: string) => T) => {
  const [chosen, setChosen] = useState<T | null>(() => {
    const raw = read(key);
    return raw === null ? null : parse(raw);
  });

  const store = (next: T) => {
    setChosen(next);
    write(key, String(next));
  };

  const reset = () => {
    setChosen(null);
    write(key, null);
  };

  return [chosen ?? fallback, store, reset] as const;
};

/**
 * Clamped on the way out of storage: the value is user-writable, `Number('')` is 0 and
 * `'99999'` is finite, and the bounds live in code while stored numbers outlive them.
 */
export const usePaneWidth = (key: string, fallback: number, min: number, max: number) =>
  useChromePref(key, fallback, raw => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  });

/** Live, so a breakpoint-dependent default keeps stepping as the window is dragged. */
export const useMediaQuery = (query: string) => {
  const list = useMemo(() => matchMedia(query), [query]);
  return useSyncExternalStore(
    onChange => {
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => list.matches,
  );
};
