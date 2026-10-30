import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type CreateAuthOverrides, createAuth } from './auth.ts';
import { getWebOrigin } from './env.ts';
import { type AppEnv, apiError, isForeignKeyViolation, jsonBodyLimit } from './http.ts';
import { accountRoute } from './routes/account.ts';
import { autoconfigRoute } from './routes/autoconfig.ts';
import { cliKeysRoute } from './routes/cli-keys.ts';
import { recordsRoute } from './routes/records.ts';
import { relayRoute } from './routes/relay.ts';
import { unlockRoute } from './routes/unlock.ts';

export const createApp = (overrides?: CreateAuthOverrides) => {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const origin = getWebOrigin(c.env);
    const corsHandler = cors({
      origin,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      // No `Authorization`: only the CLI sends a bearer, and it is no browser.
      allowHeaders: ['Content-Type', ACCOUNT_HEADER],
      credentials: true,
    });
    return corsHandler(c, next);
  });

  app.use('*', jsonBodyLimit);

  app.get('/health', c => c.json({ status: 'ok' as const }, 200));

  app.on(['GET', 'POST'], '/api/auth/*', c => {
    const auth = createAuth(c.env, overrides);
    return auth.handler(c.req.raw);
  });

  app.route('/api/v1/account', accountRoute);
  app.route('/api/v1/vault/records', recordsRoute);
  // Before `unlockRoute`, whose session middleware covers every path under `/api/v1/vault`.
  app.route('/api/v1/vault', cliKeysRoute);
  app.route('/api/v1/vault', unlockRoute);
  app.route('/api/v1/relay', relayRoute);
  app.route('/api/v1/autoconfig', autoconfigRoute);

  app.notFound(c => apiError(c, 404, 'NOT_FOUND', 'Not found'));

  app.onError((err, c) => {
    if (isForeignKeyViolation(err)) {
      return apiError(c, 401, 'UNAUTHORIZED', 'This account no longer exists');
    }
    return apiError(c, 500, 'INTERNAL_ERROR', 'Internal server error');
  });

  return app;
};
