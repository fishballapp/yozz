import { Hono } from 'hono';
import { lookupMailServers } from '../autoconfig/lookup.ts';
import { type AppEnv, apiError, requireSession } from '../http.ts';
import { parseHostname } from '../relay/target.ts';

export const autoconfigRoute = new Hono<AppEnv>().use('/', requireSession).get('/', async c => {
  const domain = parseHostname(new URL(c.req.url).searchParams.get('domain') ?? '');
  if (domain === null) {
    return apiError(c, 400, 'BAD_REQUEST', 'Invalid domain');
  }

  // Shares the relay's budget: a lookup precedes a relay connection.
  const { success } = await c.env.RELAY_RATE_LIMIT.limit({ key: c.get('user').id });
  if (!success) {
    return apiError(c, 429, 'RATE_LIMITED', 'Rate limit exceeded');
  }

  const found = await lookupMailServers(domain);
  if (found === null) {
    return apiError(c, 404, 'NOT_FOUND', 'No mail configuration is published for that domain');
  }
  return c.json(found, 200, { 'Cache-Control': 'private, max-age=86400' });
});
