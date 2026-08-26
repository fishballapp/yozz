import { createFileRoute } from '@tanstack/react-router';
import { Settings } from '../pages/Settings';

/**
 * The Settings layout: title and section tabs, with each section a child route beneath it. The
 * shell renders the mobile top bar and the status line, so the route states its own name for
 * them; every child inherits it.
 */
export const Route = createFileRoute('/_app/settings')({
  staticData: { title: 'Settings' },
  component: Settings,
});
