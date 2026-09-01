import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Mailbox } from '../pages/Mailbox';
import { mailboxIdSchema } from '../state/mail';

/**
 * `parse` accepts a view id or any email address; anything else is a 404, while an unconnected
 * address is an in-pane empty state (DECISIONS.md). `parse` may run several times, so it stays
 * pure.
 */
export const Route = createFileRoute('/_app/m/$mailbox')({
  params: {
    parse: ({ mailbox }) => {
      const parsed = mailboxIdSchema.safeParse(mailbox);
      return parsed.success ? { mailbox: parsed.data } : false;
    },
    stringify: ({ mailbox }) => ({ mailbox }),
  },
  // `?q=` is in the URL so a filtered list is linkable and a query cannot follow you to the next mailbox.
  validateSearch: z.object({
    q: z.string().min(1).optional().catch(undefined),
  }),
  component: Mailbox,
});
