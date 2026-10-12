import {
  ChangePasswordRequestSchema,
  FinalizeUnlockRequestSchema,
  PasskeyWrapResponseSchema,
  UnlockStatusResponseSchema,
} from '@yozz.app/vault-contract';
import { type Context, Hono } from 'hono';
import { createAuth } from '../auth.ts';
import {
  CredentialNotFoundError,
  changePasswordUnlock,
  finalizePasskeyUnlock,
  finalizePasswordUnlock,
  getPasskeyWrap,
  getPasswordHash,
  getUnlockStatus,
  hasPasskey,
  removePasskeyUnlock,
  resetVault,
  sessionExists,
  VaultAlreadyExistsError,
} from '../db/unlock.ts';
import {
  type AppEnv,
  apiError,
  readJsonBody,
  requireFreshSession,
  requireNamedAccount,
  requireSession,
} from '../http.ts';

/** A guarded batch that applied nothing: the session it ran for is gone, or the account moved first. */
const refusedBatch = async (c: Context<AppEnv>, sessionId: string, conflict: string) =>
  (await sessionExists(c.env.DB, sessionId, c.get('user').id))
    ? apiError(c, 409, 'CONFLICT', conflict)
    : apiError(c, 401, 'UNAUTHORIZED', 'This session ended while the change was being made');

export const unlockRoute = new Hono<AppEnv>()
  .use('*', requireSession, requireNamedAccount)
  .get('/unlock', async c => {
    const user = c.get('user');
    const status = await getUnlockStatus(c.env.DB, user.id);
    const parsed = UnlockStatusResponseSchema.parse(status);
    return c.json(parsed, 200);
  })
  .get('/unlock/passkey/:credentialId', async c => {
    const user = c.get('user');
    const credentialId = c.req.param('credentialId');
    if (!credentialId) {
      return apiError(c, 400, 'BAD_REQUEST', 'Missing credential ID');
    }

    const wrappedDek = await getPasskeyWrap(c.env.DB, user.id, credentialId);
    if (!wrappedDek) {
      return apiError(c, 404, 'NOT_FOUND', 'Passkey wrap not found');
    }

    const response = PasskeyWrapResponseSchema.parse({ wrappedDek });
    return c.json(response, 200);
  })
  .put('/unlock', requireFreshSession, async c => {
    const user = c.get('user');
    const body = await readJsonBody(c, FinalizeUnlockRequestSchema, 'unlock finalisation payload');
    if (!body.ok) return body.response;

    const now = Date.now();
    const { isNewVault, wrappedDek } = body.data;
    if (body.data.mode === 'password') {
      // Better Auth's `setPassword` is server-only and its credential write cannot join a batch, so
      // the hash is made here and the credential written beside the vault row. Changing a password
      // you already have is `PUT /unlock/password`, which asks for the current one: the batch
      // refuses an account that is in password mode by the time it runs.
      const { password } = await createAuth(c.env).$context;
      const sessionId = c.get('session').id;
      try {
        const isApplied = await finalizePasswordUnlock(c.env.DB, user.id, {
          isNewVault,
          wrappedDek,
          passwordHash: await password.hash(body.data.authValue),
          sessionId,
          now,
        });
        if (isApplied) return c.json({ ok: true as const }, 200);
      } catch (err) {
        if (err instanceof VaultAlreadyExistsError) {
          return apiError(c, 409, 'CONFLICT', err.message);
        }
        throw err;
      }
      return refusedBatch(c, sessionId, 'This account already has a password; change it instead');
    }

    try {
      await finalizePasskeyUnlock(c.env.DB, user.id, {
        isNewVault,
        credentialId: body.data.credentialId,
        wrappedDek,
        now,
      });
      return c.json({ ok: true as const }, 200);
    } catch (err) {
      if (err instanceof VaultAlreadyExistsError) return apiError(c, 409, 'CONFLICT', err.message);
      if (err instanceof CredentialNotFoundError) {
        return apiError(c, 403, 'FORBIDDEN', 'Passkey not found for this account');
      }
      throw err;
    }
  })
  .put('/unlock/password', requireFreshSession, async c => {
    const user = c.get('user');
    const body = await readJsonBody(c, ChangePasswordRequestSchema, 'password change payload');
    if (!body.ok) return body.response;

    const keepSessionId = c.get('session').id;
    const currentHash = await getPasswordHash(c.env.DB, user.id);
    if (currentHash === null) {
      return apiError(c, 403, 'INVALID_MODE', 'This account does not sign in with a password');
    }
    const { password } = await createAuth(c.env).$context;
    if (!(await password.verify({ hash: currentHash, password: body.data.currentAuthValue }))) {
      return apiError(c, 403, 'WRONG_PASSWORD', 'That is not the current password');
    }

    const isChanged = await changePasswordUnlock(c.env.DB, user.id, {
      currentHash,
      newHash: await password.hash(body.data.newAuthValue),
      wrappedDek: body.data.wrappedDek,
      keepSessionId,
      now: Date.now(),
    });
    if (!isChanged) {
      return refusedBatch(c, keepSessionId, 'The password changed somewhere else first');
    }
    return c.json({ ok: true as const }, 200);
  })
  .delete('/unlock/passkey/:credentialId', requireFreshSession, async c => {
    const user = c.get('user');
    const credentialId = c.req.param('credentialId');
    const sessionId = c.get('session').id;

    const isRemoved = await removePasskeyUnlock(c.env.DB, user.id, { credentialId, sessionId });
    if (isRemoved) return c.json({ ok: true as const }, 200);

    // Nothing applied: the session ended, the passkey is not this account's, or it is the last one.
    if (!(await sessionExists(c.env.DB, sessionId, user.id))) {
      return apiError(c, 401, 'UNAUTHORIZED', 'This session ended while the change was being made');
    }
    if (!(await hasPasskey(c.env.DB, user.id, credentialId))) {
      return apiError(c, 404, 'NOT_FOUND', 'Passkey not found');
    }
    return apiError(
      c,
      409,
      'CONFLICT',
      'This is the last passkey that can sign in; add another first',
    );
  })
  .delete('/', requireFreshSession, async c => {
    const user = c.get('user');
    await resetVault(c.env.DB, user.id);
    return c.json({ ok: true as const }, 200);
  });
