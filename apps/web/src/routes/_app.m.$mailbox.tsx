import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Mailbox } from '../pages/Mailbox';
import { mailboxIdSchema } from '../state/mail';

/**
 * A mailbox: the list column, with the reader pane as its `<Outlet/>`.
 *
 * `parse` accepts a view id or any email address. Anything else returns `false`, so the route does
 * not match and `/m/whatever` is a 404. An address that is not connected is still a valid mailbox
 * id — that is an in-pane empty state, not a 404, mirroring the dead-thread decision in DECISIONS.md.
 *
 * `parse` may run several times while the router plans a match, so it stays pure. `useParams` hands
 * the component a `MailboxId` rather than a `string`, so nothing downstream has to cast.
 */
export const Route = createFileRoute('/_app/m/$mailbox')({
  params: {
    parse: ({ mailbox }) => {
      const parsed = mailboxIdSchema.safeParse(mailbox);
      return parsed.success ? { mailbox: parsed.data } : false;
    },
    stringify: ({ mailbox }) => ({ mailbox }),
  },
  // `?q=` is the search, and it belongs in the URL for two reasons: a filtered list is a thing you
  // can link someone to, and a query held in component state silently followed you from one mailbox
  // to the next, filtering an address you had just switched to for a word you typed somewhere else.
  validateSearch: z.object({
    q: z.string().min(1).optional().catch(undefined),
  }),
  component: Mailbox,
});
