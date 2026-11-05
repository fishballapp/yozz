import { createFileRoute } from '@tanstack/react-router';
import { Settings } from '../app/Settings';

/**
 * The shell renders the mobile top bar, so the route states its own name for it; every child
 * inherits it.
 */
export const Route = createFileRoute('/_app/settings')({
  staticData: { title: 'Settings' },
  component: Settings,
});
