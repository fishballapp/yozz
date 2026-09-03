import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Address } from '../app/settings/Address';

/**
 * One address's page. Anything that is not an email address does not match and is a 404; an
 * address that is not stored is an in-pane state, the same reading a mailbox gives it.
 */
export const Route = createFileRoute('/_app/settings/a/$address')({
  params: {
    parse: ({ address }) => {
      const parsed = z.string().email().safeParse(address);
      return parsed.success ? { address: parsed.data } : false;
    },
    stringify: ({ address }) => ({ address }),
  },
  component: Address,
});
