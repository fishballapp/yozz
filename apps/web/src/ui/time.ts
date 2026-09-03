/** List timestamps are machine values in a fixed-width mono column: never more than six characters. `Date`, not `Temporal`: no web app here has adopted it. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short form for the list column: `now`, `12m`, `3h`, `Tue`, `13 Oct`. */
export const listTime = (at: number, now = Date.now()) => {
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/** Middle form for the stacked record: relative while useful, then a clock, a weekday, a date. Never wider than nine characters. */
export const stackTime = (at: number, now = Date.now()) => {
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  const date = new Date(at);
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (elapsed < DAY) return clock;
  if (elapsed < 7 * DAY)
    return `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${clock}`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/** Long form for the reader's message header: `Sun 13 Oct 2026, 09:42`. */
export const fullTime = (at: number) =>
  new Date(at).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 24-hour clock time: `14:09`. */
export const clockTime = (at: number) =>
  new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
