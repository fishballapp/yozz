import { createFileRoute } from '@tanstack/react-router';
import { AppShell } from '../components/AppShell';

// Pathless: it adds no segment to any URL, it only says "these routes are inside the app". What
// sits outside it is a page with no rail, no status line and no mailbox around it.
export const Route = createFileRoute('/_app')({ component: AppShell });
