import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { createAuth } from '../auth.ts';
import { deleteAccount } from '../db/account.ts';
import { type AppEnv, requireFreshSession, requireNamedAccount, requireSession } from '../http.ts';

export const accountRoute = new Hono<AppEnv>()
  .use('*', requireSession, requireNamedAccount)
  /** The signed-in user and everything stored for them. The session dies with the rows, so the response also expires its cookies: there is no later sign-out to do it. */
  .delete('/', requireFreshSession, async c => {
    const { id, email } = c.get('user');
    await deleteAccount(c.env.DB, { userId: id, email });

    const { authCookies } = await createAuth(c.env).$context;
    for (const { name, attributes } of [
      authCookies.sessionToken,
      authCookies.sessionData,
      authCookies.dontRememberToken,
    ]) {
      setCookie(c, name, '', { ...attributes, maxAge: 0 });
    }
    return c.json({ ok: true as const }, 200);
  });
