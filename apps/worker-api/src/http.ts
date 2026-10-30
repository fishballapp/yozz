import { type ApiErrorCode, CliTokenSchema } from '@yozz.app/vault-contract';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import type { z } from 'zod';
import { createAuth, SESSION_FRESH_AGE_SECONDS } from './auth.ts';
import { isNamedAccount } from './auth-policy.ts';
import { isTokenOf } from './cli-token.ts';
import { findCliKey } from './db/cli-keys.ts';
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
  c: Context,
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

/** The same age rule Better Auth applies to passkey registration. It guards what a stolen cookie must not do: change how the vault opens, or delete the account. */
const isSessionFresh = (session: AuthSession['session']): boolean =>
  Date.now() - new Date(session.createdAt).getTime() < SESSION_FRESH_AGE_SECONDS * 1000;

const refuseStaleSession = (c: Context) =>
  apiError(c, 403, 'SESSION_NOT_FRESH', 'Sign in again to make this change');

/** After `requireSession`. */
export const requireFreshSession = createMiddleware<AppEnv>(async (c, next) => {
  if (!isSessionFresh(c.get('session'))) return refuseStaleSession(c);
  return next();
});

/**
 * The vault tables reference `user`, so a write that passed its session check and then lost a race
 * with account deletion fails here, not as a row under a dead user id.
 */
export const isForeignKeyViolation = (err: unknown): boolean =>
  err instanceof Error && /FOREIGN KEY constraint failed/.test(err.message);

export const jsonBodyLimit = bodyLimit({
  maxSize: 2 * 1024 * 1024,
  onError: c =>
    apiError(c, 413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds maximum allowed size'),
});

export const readJsonBody = async <S extends z.ZodType>(
  c: Context,
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

/**
 * Who a route that a CLI key may reach is acting for. A CLI key reaches the record routes and its
 * own key, nothing else: every other route takes `requireSession`, which reads the cookie alone.
 */
export type Caller =
  | {
      readonly kind: 'session';
      readonly userId: string;
      readonly session: AuthSession['session'];
    }
  | { readonly kind: 'cli-key'; readonly userId: string; readonly keyId: string };

export type CliKeyCaller = Extract<Caller, { kind: 'cli-key' }>;

export type CallerEnv = { Bindings: RuntimeEnv; Variables: { caller: Caller } };

const BEARER = /^Bearer (?<token>\S+)$/;

/** The key a bearer names, if the token hashes to what its row keeps; `null` for anything else. */
const cliKeyOf = async (db: D1Database, authorization: string): Promise<CliKeyCaller | null> => {
  const parsed = CliTokenSchema.safeParse(BEARER.exec(authorization)?.groups?.token);
  if (!parsed.success) return null;
  const { token, keyId } = parsed.data;
  const key = await findCliKey(db, keyId);
  if (key === null || !(await isTokenOf(token, key.tokenHash))) return null;
  return { kind: 'cli-key', userId: key.userId, keyId };
};

const sessionOf = async (env: RuntimeEnv, headers: Headers): Promise<Caller | null> => {
  const session = await createAuth(env).api.getSession({ headers });
  return session === null
    ? null
    : { kind: 'session', userId: session.user.id, session: session.session };
};

/** A CLI key answers for its own account only, as a session does (`requireNamedAccount`). */
const refuseUnnamedAccount = (c: Context, caller: Caller) =>
  isNamedAccount(c.req.raw.headers, caller.userId)
    ? null
    : apiError(
        c,
        403,
        'ACCOUNT_MISMATCH',
        caller.kind === 'session'
          ? 'This browser is signed in to another account now'
          : 'This CLI key belongs to another account',
      );

/**
 * A browser session or a CLI key, for the named account. A request carrying a bearer is judged on
 * the bearer alone, never on a cookie beside it.
 */
export const requireCaller = createMiddleware<CallerEnv>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  const caller =
    authorization === undefined
      ? await sessionOf(c.env, c.req.raw.headers)
      : await cliKeyOf(c.env.DB, authorization);
  if (caller === null) return apiError(c, 401, 'UNAUTHORIZED', 'Authentication required');
  const refused = refuseUnnamedAccount(c, caller);
  if (refused !== null) return refused;
  c.set('caller', caller);
  return next();
});

/** A CLI key's bearer only, for the named account. */
export const requireCliKey = createMiddleware<{
  Bindings: RuntimeEnv;
  Variables: { cliKey: CliKeyCaller };
}>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  const cliKey = authorization === undefined ? null : await cliKeyOf(c.env.DB, authorization);
  if (cliKey === null) return apiError(c, 401, 'UNAUTHORIZED', 'A CLI key is required');
  const refused = refuseUnnamedAccount(c, cliKey);
  if (refused !== null) return refused;
  c.set('cliKey', cliKey);
  return next();
});

/** After `requireCaller`, on a change a CLI key may make to itself: a session making it must be fresh. */
export const requireFreshCaller = createMiddleware<CallerEnv>(async (c, next) => {
  const caller = c.get('caller');
  if (caller.kind === 'session' && !isSessionFresh(caller.session)) return refuseStaleSession(c);
  return next();
});
