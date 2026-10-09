import type { ApiErrorCode } from '@yozz.app/vault-contract';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';
import { createAuth, SESSION_FRESH_AGE_SECONDS } from './auth.ts';
import { isNamedAccount } from './auth-policy.ts';
import type { RuntimeEnv } from './env.ts';

export type AuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createAuth>['api']['getSession']>>
>;

export type AppEnv = {
  Bindings: RuntimeEnv;
  Variables: {
    user: AuthSession['user'];
    session: AuthSession['session'];
  };
};

export const apiError = (
  c: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 426 | 429 | 500 | 502,
  code: ApiErrorCode,
  message: string,
) => {
  return c.json(
    {
      error: {
        code,
        message,
      },
    },
    status,
  );
};

export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return apiError(c, 401, 'UNAUTHORIZED', 'Authentication required');
  }

  c.set('user', session.user);
  c.set('session', session.session);
  return next();
});

/**
 * After `requireSession`, on every vault route, before anything is read or written: a request one
 * tab made for its account can arrive with the session another tab signed in since.
 */
export const requireNamedAccount = createMiddleware<AppEnv>(async (c, next) => {
  if (!isNamedAccount(c.req.raw.headers, c.get('user').id)) {
    return apiError(c, 403, 'ACCOUNT_MISMATCH', 'This browser is signed in to another account now');
  }
  return next();
});

/** After `requireSession`: the same age rule Better Auth applies to passkey registration. */
export const requireFreshSession = createMiddleware<AppEnv>(async (c, next) => {
  const age = Date.now() - new Date(c.get('session').createdAt).getTime();
  if (age >= SESSION_FRESH_AGE_SECONDS * 1000) {
    return apiError(c, 403, 'SESSION_NOT_FRESH', 'Sign in again to change how this vault opens');
  }
  return next();
});

export const jsonBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: c =>
    apiError(
      c as Context<AppEnv>,
      413,
      'PAYLOAD_TOO_LARGE',
      'Request payload exceeds maximum allowed size',
    ),
});

export const readJsonBody = async <S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
  what: string,
): Promise<
  | { readonly ok: true; readonly data: z.output<S> }
  | { readonly ok: false; readonly response: Response }
> => {
  const parsed = await (async () => {
    try {
      return schema.safeParse(await c.req.json());
    } catch {
      return null;
    }
  })();
  if (parsed === null) {
    return { ok: false, response: apiError(c, 400, 'BAD_REQUEST', 'Invalid JSON body') };
  }
  if (!parsed.success) {
    return { ok: false, response: apiError(c, 400, 'BAD_REQUEST', `Invalid ${what}`) };
  }
  return { ok: true, data: parsed.data };
};
