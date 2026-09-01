import { createFileRoute } from '@tanstack/react-router';
import { Thread } from '../pages/Thread';

/**
 * A splat, not a single param: a thread id contains slashes, and one `$param` escapes them on
 * the way out. A thread id is data, so an unknown one is a matched route that finds nothing (an
 * in-pane empty state), not a 404; see DECISIONS.md, "A bad address".
 */
export const Route = createFileRoute('/_app/m/$mailbox/t/$')({ component: Thread });
