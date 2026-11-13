import { createFileRoute, redirect } from '@tanstack/react-router';

// Inside the app `/` is the inbox. A browser that loads yozz.app/ signed out is shown the landing
// page instead (apps/worker-web), and never reaches this route.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/m/$view', params: { view: 'unified' } });
  },
});
