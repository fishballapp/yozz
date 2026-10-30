/**
 * The long form of a time, `Sun 13 Oct 2026, 09:42`: the reader's message header, and the line a
 * quote opens with, which every client writes alike. `Date`, not `Temporal`: no YOZZ app has adopted it.
 */
export const fullTime = (at: number) =>
  new Date(at).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
