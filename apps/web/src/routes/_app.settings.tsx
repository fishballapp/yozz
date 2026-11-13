import { createFileRoute } from '@tanstack/react-router';
import { Settings } from '../app/Settings';

/**
 * The shell renders the mobile top bar, so each route states its own name for it: this one for the
 * list, and every pane route its own page title, since below `lg` the pane shows no title of its own.
 */
export const Route = createFileRoute('/_app/settings')({
  staticData: { title: 'Settings' },
  component: Settings,
});
