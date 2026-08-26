import { connect } from 'cloudflare:sockets';
import { Hono } from 'hono';
import { getWebOrigin } from '../env.ts';
import { type AppEnv, apiError, requireSession } from '../http.ts';
import { pipeSocket } from '../relay/pipe.ts';
import { resolvePublicAddress } from '../relay/resolve.ts';
import { parseRelayTarget } from '../relay/target.ts';

/**
 * `GET /api/v1/relay?host=<hostname>&port=<993|465>` — the WebSocket-to-TCP byte pipe the
 * browser's own TLS client runs over. Every rejection before the upgrade is a plain HTTP error,
 * so each one is reachable with curl. The order is the order of cost: header checks, then the
 * session, then DNS, then TCP.
 *
 * `secureTransport` is never set on the socket: TLS belongs in the browser, and "on" would hand
 * this Worker the session key and every password (ARCHITECTURE.md).
 */
export const relayRoute = new Hono<AppEnv>()
  .use('/', async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return apiError(c, 426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
    }
    // Browsers always send Origin on an upgrade; CORS never applies to one, so this is the
    // cross-site check.
    if (c.req.header('Origin') !== getWebOrigin(c.env)) {
      return apiError(c, 403, 'FORBIDDEN', 'Forbidden');
    }
    return next();
  })
  .use('/', requireSession)
  .get('/', async c => {
    const target = parseRelayTarget(new URL(c.req.url).searchParams);
    if (!target) {
      return apiError(c, 400, 'BAD_REQUEST', 'Invalid relay target');
    }

    const { success } = await c.env.RELAY_RATE_LIMIT.limit({ key: c.get('user').id });
    if (!success) {
      return apiError(c, 429, 'RATE_LIMITED', 'Rate limit exceeded');
    }

    // Connect to the address the check saw, so a name cannot resolve differently twice.
    const address = await resolvePublicAddress(target.hostname);
    if (!address) {
      return apiError(c, 403, 'FORBIDDEN', 'Host is not publicly routable');
    }

    const socket = connect({ hostname: address, port: target.port }, { allowHalfOpen: true });
    try {
      await socket.opened;
    } catch {
      await socket.close().catch(() => {});
      return apiError(c, 502, 'UPSTREAM_UNREACHABLE', 'Upstream host unreachable');
    }

    const pair = new WebSocketPair();
    pair[1].accept();
    pipeSocket(pair[1], socket, target, c.executionCtx);
    return new Response(null, { status: 101, webSocket: pair[0] });
  });
