import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type CreateAuthOverrides, createAuth } from './auth.ts';
import { getWebOrigin } from './env.ts';
import { type AppEnv, apiError, jsonBodyLimit } from './http.ts';
import { autoconfigRoute } from './routes/autoconfig.ts';
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
      allowHeaders: ['Content-Type', 'Authorization'],
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

  app.route('/api/v1/vault/records', recordsRoute);
  app.route('/api/v1/vault', unlockRoute);
  app.route('/api/v1/relay', relayRoute);
  app.route('/api/v1/autoconfig', autoconfigRoute);

  app.notFound(c => apiError(c, 404, 'NOT_FOUND', 'Not found'));

  app.onError((_err, c) => {
    return apiError(c, 500, 'INTERNAL_ERROR', 'Internal server error');
  });

  return app;
};
