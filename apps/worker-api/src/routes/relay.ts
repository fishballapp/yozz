import { connect } from 'cloudflare:sockets';
import { Hono } from 'hono';
import { getWebOrigin } from '../env.ts';
import { type AppEnv, apiError, requireSession } from '../http.ts';
import { pipeSocket } from '../relay/pipe.ts';
import { resolvePublicAddress } from '../relay/resolve.ts';
import { parseRelayTarget } from '../relay/target.ts';

/** `secureTransport` is never set on the socket: TLS belongs in the browser. */
export const relayRoute = new Hono<AppEnv>()
  .use('/', async (c, next) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return apiError(c, 426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required');
    }
    // CORS never applies to an upgrade, so this is the cross-site check.
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

    // Connect to the address that passed the check, not the name.
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
