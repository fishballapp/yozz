import { createRootRoute, Outlet } from '@tanstack/react-router';
import { z } from 'zod';
import { Compose } from '../components/Compose';
import { Toasts } from '../components/ui/Toast';
import { composeIntentSchema } from '../lib/compose';
import { NotFound } from '../pages/NotFound';
import { MailProvider } from '../state/mail';
import { VaultProvider } from '../vault/session';

/**
 * The app shell's outermost ring: the vault session, the mail store, and the composer.
 *
 * The vault sits outside mail because it outlives the fixtures conceptually and depends on
 * nothing in them. The composer sits here rather than in a page because it is valid over every
 * route — you can start a message from the mail, from Settings, from anywhere — and because a
 * draft has to survive navigating between mailboxes.
 *
 * `?compose=` is declared HERE for the same reason. A search param is only readable by routes at or
 * below the one that validates it, so a param that must work everywhere belongs on the root, and
 * every navigation in the app carries it through by spreading the previous search.
 *
 * The design direction (thesis, palette, form) lives in DESIGN.md.
 */
export const Route = createRootRoute({
  validateSearch: z.object({
    // `.catch` per field, not on the object: one unrecognised param must not throw away the ones
    // beside it that parsed. A junk `?compose=` reads as "the composer is closed", which is the
    // only safe reading of it.
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
