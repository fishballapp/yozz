import { cn } from '@fishballapps/cn';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { isUnsavedWork, type TrackedActivity } from '../relay/activity';
import { useMail } from '../store/MailProvider';

/** Work someone asked for shows once it is not instant, so a star or an archive does not flash it. */
const USER_DELAY_MS = 200;
/** Work nobody asked for (a prefetch) shows only once it is slow. */
const BACKGROUND_DELAY_MS = 3000;

const delayOf = ({ priority }: TrackedActivity) =>
  priority === 'user' ? USER_DELAY_MS : BACKGROUND_DELAY_MS;

/**
 * What the bar shows at `now`: nothing, a read, or a write a reload would lose. A write wins, since
 * it is the one that asks you not to leave.
 */
export const barAt = (
  activities: readonly TrackedActivity[],
  now: number,
): 'off' | 'read' | 'write' => {
  const shown = activities.filter(activity => now - activity.startedAt >= delayOf(activity));
  if (shown.length === 0) return 'off';
  return shown.some(isUnsavedWork) ? 'write' : 'read';
};

/** How long until the next piece of work is old enough to show, or null when none is waiting. */
export const nextShowIn = (activities: readonly TrackedActivity[], now: number): number | null => {
  const waits = activities
    .map(activity => activity.startedAt + delayOf(activity) - now)
    .filter(wait => wait > 0);
  return waits.length === 0 ? null : Math.min(...waits);
};

/**
 * A 2px bar along the very top while YOZZ is talking to a mail server: `--paper-dim` while it only
 * reads, `--signal` while a write someone asked for is on its way, the same rule as the reload
 * warning. Laid over the page, so it never moves anything; decorative, because the status line is
 * what says when something went wrong.
 */
export const ActivityBar = () => {
  const { activity } = useMail();
  const activities = useSyncExternalStore(activity.subscribe, activity.snapshot);
  const [now, setNow] = useState(Date.now);

  // Looks again whenever the list changes, and when the next piece of work crosses its delay.
  useEffect(() => {
    setNow(Date.now());
    const wait = nextShowIn(activities, Date.now());
    if (wait === null) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [activities]);

  const bar = barAt(activities, now);
  // Kept through the fade-out, or a write's bar would turn grey as it leaves.
  const [tone, setTone] = useState<'read' | 'write'>('read');
  if (bar !== 'off' && bar !== tone) setTone(bar);

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-70 h-0.5 overflow-hidden transition-opacity duration-300',
        bar === 'off' ? 'opacity-0' : 'opacity-100',
      )}
    >
      <div
        className={cn(
          'h-full w-[30%] animate-activity-slide motion-reduce:w-full motion-reduce:animate-none',
          tone === 'write' ? 'bg-signal' : 'bg-paper-dim',
        )}
      />
    </div>
  );
};
