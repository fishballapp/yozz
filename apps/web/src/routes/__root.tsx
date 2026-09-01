import { createRootRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { Compose } from '../components/Compose';
import { Toasts } from '../components/ui/Toast';
import { composeIntentSchema } from '../lib/compose';
import { NotFound } from '../pages/NotFound';
import { MailProvider } from '../state/mail';
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
