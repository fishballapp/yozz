import { createRootRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { NotFound } from '../app/NotFound';
import { Compose } from '../compose/Compose';
import { composeIntentSchema } from '../compose/intent';
import { MailProvider } from '../store/MailProvider';
import { Toasts } from '../ui/Toast';
import { VaultProvider } from '../vault/session';

/**
 * `?compose=` is declared here because a search param is readable only at or below the route that
 * validates it, and the composer is valid over every route.
 */
export const Route = createRootRoute({
  validateSearch: z.object({
    // `.catch` per field: one unrecognised param must not throw away the others. A junk `?compose=` reads as closed.
    compose: composeIntentSchema.optional().catch(undefined),
  }),
  component: RootLayout,
  notFoundComponent: NotFound,
});

function RootLayout() {
  return (
    <VaultProvider>
      <MailProvider>
        <Outlet />
        <Compose />
        <Toasts />
      </MailProvider>
    </VaultProvider>
  );
}
