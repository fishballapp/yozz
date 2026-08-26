import { Hono } from 'hono';
import { lookupMailServers } from '../autoconfig/lookup.ts';
import { type AppEnv, apiError, requireSession } from '../http.ts';
import { parseHostname } from '../relay/target.ts';

/**
 * `GET /api/v1/autoconfig?domain=<domain>` — the mail servers a domain publishes, for the
 * add-address form. Session-gated and rate-limited like the relay, because each call fans out to
 * several third-party fetches on the caller's behalf. Only a domain is accepted: the address
 * itself stays in the browser.
 */
export const autoconfigRoute = new Hono<AppEnv>().use('/', requireSession).get('/', async c => {
  const domain = parseHostname(new URL(c.req.url).searchParams.get('domain') ?? '');
  if (domain === null) {
    return apiError(c, 400, 'BAD_REQUEST', 'Invalid domain');
  }

  // ponytail: shares the relay's budget (30/min per user) rather than adding a second binding;
  // a lookup precedes a relay connection, so the two are the same activity.
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
