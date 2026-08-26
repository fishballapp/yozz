import { createFileRoute } from '@tanstack/react-router';
import { ReaderRest } from '../components/ReaderRest';

// Nothing open. This is a route rather than a branch inside the reader pane because "no message
// selected" is a real, linkable place in a mailbox — it is what `/m/unified` IS.
export const Route = createFileRoute('/_app/m/$mailbox/')({ component: ReaderRest });
