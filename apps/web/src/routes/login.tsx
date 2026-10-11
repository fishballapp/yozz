import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Login } from '../vault/Login';

/** A deleted account lands here, and says so once. */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    deleted: z.literal(true).optional().catch(undefined),
  }),
  component: LoginRoute,
});

function LoginRoute() {
  const { deleted } = Route.useSearch();
  return <Login isAccountDeleted={deleted === true} />;
}
