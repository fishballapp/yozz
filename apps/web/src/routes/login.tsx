import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Login } from '../vault/Login';

/**
 * A deleted account lands here, and says so once. `approve` is a CLI approval's query, kept as the
 * raw string it arrived as, so the page it returns to parses it exactly as the CLI wrote it.
 */
export const Route = createFileRoute('/login')({
  validateSearch: z.object({
    deleted: z.literal(true).optional().catch(undefined),
    approve: z.string().optional().catch(undefined),
  }),
  component: LoginRoute,
});

function LoginRoute() {
  const { deleted, approve } = Route.useSearch();
  return <Login isAccountDeleted={deleted === true} cliApproval={approve} />;
}
