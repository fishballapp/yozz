import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Account } from '../app/settings/Account';

/** A change that returns here says what it did, so the notice survives the page change. */
export const Route = createFileRoute('/_app/settings/account')({
  staticData: { title: 'Sign-in' },
  validateSearch: z.object({
    notice: z.enum(['switched', 'changed']).optional().catch(undefined),
  }),
  component: AccountRoute,
});

function AccountRoute() {
  const { notice } = Route.useSearch();
  return <Account notice={notice} />;
}
