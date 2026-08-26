import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { Enrol } from '../pages/Enrol';

export const Route = createFileRoute('/enrol')({
  // `?reset=1` is how a RECOVERY link is told apart from a signup link: the same
  // route serves both, and only the recovery one may wipe a live vault.
  // `.catch` per field, per the root route's rule.
  validateSearch: z.object({ reset: z.literal('1').optional().catch(undefined) }),
  component: Enrol,
});
