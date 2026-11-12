/** List timestamps are machine values in a fixed-width mono column: never more than six characters. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short form for the list column: `now`, `12m`, `3h`, `Tue`, `13 Oct`. */
export const listTime = (at: number, now = Date.now()) => {
  const elapsed = now - at;
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  const instant = Temporal.Instant.fromEpochMilliseconds(at);
  if (elapsed < 7 * DAY) return instant.toLocaleString('en-GB', { weekday: 'short' });
  return instant.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
};

/** A calendar day, for a fact about the past with no clock time worth reading: `13 Oct 2026`. */
export const fullDate = (at: number) =>
  Temporal.Instant.fromEpochMilliseconds(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
