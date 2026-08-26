import { createFileRoute } from '@tanstack/react-router';
import { Thread } from '../pages/Thread';

/**
 * One open message. The id is a SPLAT (`$`), not a single param: a real thread id is
 * `address/folder/uid`, and a slash inside one `$param` gets escaped on the way out and decoded back
 * into a second segment on reload. The splat takes the rest of the path verbatim.
 *
 * A thread id cannot be checked the way a mailbox id can — it is data, not a closed set, so an
 * unknown one is a route that matches and finds nothing rather than a route that fails to match.
 * That distinction is the app's rule for bad addresses: an unknown route SHAPE is a 404, and a
 * known shape holding a missing thing is a designed empty state in the pane that owns it, with the
 * rail and the list still around it. A message you archived on another device should not blank the
 * whole app.
 *
 * This is also where a `loader` goes the day mail is real: fetching a thread's bodies is per-thread
 * work with its own pending and error states, and the reader pane can show them while the list
 * beside it stays live. Nothing to load yet — the fixtures are already in the store.
 */
export const Route = createFileRoute('/_app/m/$mailbox/t/$')({ component: Thread });
