/** Every rule fails closed: a body shape it does not recognise throws rather than falling through. */
import { APIError } from 'better-auth/api';
import { type CreateAuthOverrides, createAuth } from './auth.ts';
import { isPasskeyWrapped } from './db/unlock.ts';
import type { RuntimeEnv } from './env.ts';

/** Each would change a live unlock credential without re-wrapping the DEK, stranding the vault. */
export const DISABLED_ENDPOINTS: ReadonlySet<string> = new Set([
  '/change-password',
  '/request-password-reset',
  '/reset-password',
  '/change-email',
  '/sign-up/email',
]);

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

/** Anything unlisted passes. */
export const ENDPOINT_POLICIES: Readonly<
  Record<string, (context: PolicyContext) => Promise<void>>
> = {
  '/sign-in/magic-link': refuseRecoveryOfUnknownEmail,
  '/sign-in/email': requireActivePasswordMode,
  '/passkey/verify-authentication': requireActivePasskeyMode,
  '/passkey/delete-passkey': refuseWrappedPasskeyDeletion,
};
