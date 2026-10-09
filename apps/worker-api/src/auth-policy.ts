/** Every rule fails closed: a body shape it does not recognise throws rather than falling through. */
import { ACCOUNT_HEADER } from '@yozz.app/vault-contract';
import { APIError } from 'better-auth/api';
import { type CreateAuthOverrides, createAuth } from './auth.ts';
import { isPasskeyWrapped } from './db/unlock.ts';
import type { RuntimeEnv } from './env.ts';

type PolicyContext = {
  readonly env: RuntimeEnv;
  readonly overrides?: CreateAuthOverrides;
  readonly body: unknown;
  readonly headers?: Headers;
};

const badRequest = (message: string): never => {
  throw new APIError('BAD_REQUEST', { message, code: 'BAD_REQUEST' });
};

const invalidMode = (message: string): never => {
  throw new APIError('FORBIDDEN', { message, code: 'INVALID_MODE' });
};

const requireActivePasswordMode = async ({ env, body }: PolicyContext): Promise<void> => {
  const email = (body as { email?: string } | undefined)?.email;
  if (!email) return badRequest('Password sign-in requires an email');

  const user = await env.DB.prepare('SELECT id FROM user WHERE lower(email) = lower(?)')
    .bind(email.trim())
    .first<{ id: string }>();
  // An unknown user falls through to Better Auth's own refusal: no enumeration oracle here.
  if (!user) return;

  const account = await env.DB.prepare('SELECT unlock_mode FROM vault_account WHERE user_id = ?')
    .bind(user.id)
    .first<{ unlock_mode: string }>();
  if (account?.unlock_mode !== 'password') {
    return invalidMode('Account is not in password mode');
  }
};

/** `response` is the WebAuthn AuthenticationResponseJSON; its `id` is the credential id. */
const requireActivePasskeyMode = async ({ env, body }: PolicyContext): Promise<void> => {
  const credentialId = (body as { response?: { id?: string } } | undefined)?.response?.id;
  if (!credentialId) return badRequest('Passkey authentication requires a credential id');

  const passkey = await env.DB.prepare(
    `SELECT a.unlock_mode, w.wrapped_dek
       FROM passkey p
       LEFT JOIN vault_account a ON a.user_id = p.userId
       LEFT JOIN vault_passkey_wrap w ON w.user_id = p.userId AND w.passkey_id = p.id
       WHERE p.credentialID = ?`,
  )
    .bind(credentialId)
    .first<{ unlock_mode: string | null; wrapped_dek: string | null }>();
  if (!passkey) return;

  if (passkey.unlock_mode !== 'passkey' || !passkey.wrapped_dek) {
    return invalidMode('Account is not in passkey mode or passkey is not wrapped');
  }
};

const refuseWrappedPasskeyDeletion = async ({
  env,
  overrides,
  body,
  headers,
}: PolicyContext): Promise<void> => {
  // The passkey ROW id, not the credential id.
  const passkeyId = (body as { id?: string } | undefined)?.id;
  if (!passkeyId) return badRequest('Passkey deletion requires a passkey id');

  const session = await createAuth(env, overrides).api.getSession({
    headers: headers ?? new Headers(),
  });
  if (!session) {
    throw new APIError('UNAUTHORIZED', {
      message: 'Passkey deletion requires a session',
      code: 'UNAUTHORIZED',
    });
  }

  if (await isPasskeyWrapped(env.DB, session.user.id, passkeyId)) {
    throw new APIError('FORBIDDEN', {
      message: 'Cannot delete active wrapped passkey',
      code: 'PASSKEY_IN_USE',
    });
  }
};

/**
 * Whether a request names (`ACCOUNT_HEADER`) the account whose session it carries. The session
 * cookie belongs to the browser, so another tab's sign-in can replace it under a request one tab
 * made for its own account; an unnamed request is refused too, which leaves a tab from before the
 * header nothing to do but fail until it reloads.
 */
export const isNamedAccount = (headers: Headers, userId: string): boolean =>
  headers.get(ACCOUNT_HEADER) === userId;

/** The vault routes ask the same through `requireNamedAccount` in `http.ts`. */
const requireNamedAccount = async ({
  env,
  overrides,
  headers = new Headers(),
}: PolicyContext): Promise<void> => {
  const session = await createAuth(env, overrides).api.getSession({ headers });
  if (!session) {
    throw new APIError('UNAUTHORIZED', {
      message: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
  }
  if (!isNamedAccount(headers, session.user.id)) {
    throw new APIError('FORBIDDEN', {
      message: 'This browser is signed in to another account now',
      code: 'ACCOUNT_MISMATCH',
    });
  }
};

/** Registration from a session must not mint a second session that outlives the first. */
const refuseSessionFromRegistration = async ({ body }: PolicyContext): Promise<void> => {
  if ((body as { createSession?: unknown } | undefined)?.createSession !== undefined) {
    return badRequest('Adding a passkey never creates a session');
  }
};

/** One magic-link endpoint serves signup and recovery; a recovery link (`?reset=1`) for an unknown address would otherwise create an account. */
const refuseRecoveryOfUnknownEmail = async ({ env, body }: PolicyContext): Promise<void> => {
  const { email, callbackURL } =
    (body as { email?: string; callbackURL?: string } | undefined) ?? {};
  if (!email) return badRequest('Magic link requires an email');
  if (!callbackURL) return;
  const isRecovery = new URL(callbackURL, 'http://placeholder').searchParams.get('reset') === '1';
  if (!isRecovery) return;

  const user = await env.DB.prepare('SELECT id FROM user WHERE lower(email) = lower(?)')
    .bind(email.trim())
    .first<{ id: string }>();
  if (!user) {
    throw new APIError('NOT_FOUND', { message: 'No account for that email', code: 'NOT_FOUND' });
  }
};

/**
 * Every Better Auth path the app calls, each with what the vault requires of it, run in order. Any
 * other path is refused: a password change or reset, an email change or signup would each change a
 * live unlock credential without re-wrapping the DEK, and the rest (`/update-user`,
 * `/revoke-sessions`, `/list-user-passkeys`, …) would act on whichever account holds the cookie.
 * Signing in names no account: whoever signs in is the account.
 */
export const ENDPOINT_POLICIES: Readonly<
  Record<string, readonly ((context: PolicyContext) => Promise<void>)[]>
> = {
  '/get-session': [],
  '/sign-in/magic-link': [refuseRecoveryOfUnknownEmail],
  '/magic-link/verify': [],
  '/sign-in/email': [requireActivePasswordMode],
  '/passkey/generate-authenticate-options': [],
  '/passkey/verify-authentication': [requireActivePasskeyMode],
  '/passkey/generate-register-options': [requireNamedAccount],
  '/passkey/verify-registration': [requireNamedAccount, refuseSessionFromRegistration],
  '/passkey/delete-passkey': [requireNamedAccount, refuseWrappedPasskeyDeletion],
  '/sign-out': [requireNamedAccount],
};
