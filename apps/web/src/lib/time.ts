/**
 * Timestamps in the list column are machine values: they sit in a fixed-width mono column and are
 * scanned vertically, so they are formatted to stay short (never more than six characters) and to
 * change unit as the message ages, the way a mail client has always done it.
 *
 * `Date` rather than `Temporal` deliberately — no web app in this repo has adopted Temporal, and a
 * relative label plus one absolute stamp does not justify pulling in the polyfill.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short form for the list's right-hand column: `now`, `12m`, `3h`, `Tue`, `13 Oct`. */
export const listTime = (at: number, now = Date.now()) => {
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 7 * DAY) return new Date(at).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/**
 * Middle form for the stacked record, which has a whole line to itself rather than a 44px column.
 * It stays relative while relative is the useful answer — an hour old is "23m", not "14:09" — then
 * switches to a clock, then to a weekday, then to a date. Never wider than nine characters, so it
 * still sits in a right-hand column without pushing the subject around.
 */
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
