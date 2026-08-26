import { createFileRoute, redirect } from '@tanstack/react-router';

// There is no separate landing surface: YOZZ opens straight into the unified stream.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/m/$mailbox', params: { mailbox: 'unified' } });
  },
});
