import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Enrol } from '../vault/Enrol';

/**
 * `?reset=true` is how a RECOVERY link is told apart from a signup link: the same route serves
 * both, and only the recovery one may wipe a live vault. The router parses the query as JSON, so
 * the flag is a boolean, as `/login?deleted=true` is.
 */
export const enrolSearch = z.object({ reset: z.literal(true).optional().catch(undefined) });

export const Route = createFileRoute('/enrol')({
  // `.catch` per field, per the root route's rule.
  validateSearch: enrolSearch,
  component: Enrol,
});
