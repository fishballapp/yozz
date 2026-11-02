import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { createAuth } from '../auth.ts';
import { deleteAccount } from '../db/account.ts';
import { deleteAllFileObjects } from '../db/files.ts';
import { type AppEnv, requireFreshSession, requireNamedAccount, requireSession } from '../http.ts';

export const accountRoute = new Hono<AppEnv>()
  .use('*', requireSession, requireNamedAccount)
  /** The signed-in user and everything stored for them. The session dies with the rows, so the response also expires its cookies: there is no later sign-out to do it. */
  .delete('/', requireFreshSession, async c => {
    const { id, email } = c.get('user');
    // Objects first: while the account stands, a failure here can be retried.
    await deleteAllFileObjects(c.env.FILES, id);
    await deleteAccount(c.env.DB, { userId: id, email });
    // An upload whose `put` landed before the batch saw its row; the account answers either way.
    c.executionCtx.waitUntil(deleteAllFileObjects(c.env.FILES, id));

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
