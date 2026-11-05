import { createFileRoute } from '@tanstack/react-router';
import { viewIdSchema } from '@yozz.app/mail/threads/views';
import { z } from 'zod';
import { ViewPage } from '../threads/ViewPage';

/**
 * `parse` accepts a view id or any email address; anything else is a 404, while an unconnected
 * address is an in-pane empty state (DECISIONS.md). `parse` may run several times, so it stays
 * pure.
 */
export const Route = createFileRoute('/_app/m/$view')({
  params: {
    parse: ({ view }) => {
      const parsed = viewIdSchema.safeParse(view);
      return parsed.success ? { view: parsed.data } : false;
    },
    stringify: ({ view }) => ({ view }),
  },
  // `?q=` is in the URL so a filtered list is linkable and a query cannot follow you to the next
  // view. Empty is a query too, and no `?q=` is the view's own.
  validateSearch: z.object({
    q: z.string().optional().catch(undefined),
  }),
  component: ViewPage,
});
