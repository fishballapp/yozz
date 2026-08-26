import { useMemo, useState, useSyncExternalStore } from 'react';

/**
 * How the app is SHAPED — pane widths, list layout — survives a reload; what the app CONTAINS does
 * not (except vault records, which the vault holds). A pane you dragged and a layout you chose are
 * yours, and re-doing them on every visit is worse than not offering them at all.
 *
 * Read in the initialiser rather than in an effect: a pane that paints at the default width and
 * then snaps to the stored one is a worse first frame than no persistence at all.
 *
 * Every write is guarded, because storage can be denied outright (a sandboxed frame, a hardened
 * profile) and a preference that cannot be saved is not worth taking the whole app down for.
 *
 * Dev-only: `localStorage.setItem('yozz:demo','1')` turns on the fixture inbox without a vault.
 * `isDemo()` is a build-time + storage check — the fixture module is dead code in production.
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

/**
 * Fixture inbox for judging the list design in dev. Total like every other parse in this file:
 * a denied or missing store is just "not demo".
 */
export const isDemo = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem('yozz:demo') === '1';
  } catch {
    return false;
  }
};

/**
 * `null` is held INSIDE the hook rather than collapsed at read time, so "never chosen" stays
 * distinguishable from "chosen, and happens to equal the default". That is what lets a default keep
 * moving — a pane that has never been dragged still steps with the viewport, and `reset` hands it
 * back to that behaviour rather than freezing it at whatever the default was on the day you reset.
 */
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
 * A dragged pane width in px, clamped to its bounds ON THE WAY OUT OF STORAGE.
 *
 * localStorage is a trust boundary like any other — the value is user-writable, survives across
 * versions, and `Number()` is generous: `''` and `'   '` both become `0`, `'0x10'` becomes 16, and
 * `'99999'` is perfectly finite. Left unchecked, a stored `99999` renders a 99999px rail that
 * pushes the reader off-screen with the drag handle out there too, so there is no way back without
 * clearing site data.
 *
 * The more likely path is not corruption but time: the bounds live in code and the stored numbers
 * do not, so the day a max is lowered every existing reader is stranded above it. Clamping here
 * means the bounds are always the ones this build believes in.
 */
export const usePaneWidth = (key: string, fallback: number, min: number, max: number) =>
  useChromePref(key, fallback, raw => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
  });

/** Live, so a default that depends on the breakpoint keeps stepping as the window is dragged. */
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
