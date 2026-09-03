import { createRootRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { NotFound } from '../app/NotFound';
import { Compose } from '../compose/Compose';
import { composeIntentSchema } from '../compose/intent';
import { MailProvider } from '../store/MailProvider';
import { Toasts } from '../ui/Toast';
import { VaultProvider } from '../vault/session';

/**
 * The vault session, the mail store, and the composer, which is valid over every route.
 * `?compose=` is declared here because a search param is readable only at or below the route
 * that validates it. Design direction lives in DESIGN.md.
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
