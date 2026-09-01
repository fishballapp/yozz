import {
  FinalizeUnlockRequestSchema,
  PasskeyWrapResponseSchema,
  UnlockStatusResponseSchema,
} from '@yozz.app/vault-contract';
import { Hono } from 'hono';
import { createAuth } from '../auth.ts';
import {
  CredentialNotFoundError,
  finalizePasskeyUnlock,
  finalizePasswordUnlock,
  getPasskeyWrap,
  getUnlockStatus,
  resetVault,
  VaultAlreadyExistsError,
} from '../db/unlock.ts';
import { type AppEnv, apiError, readJsonBody, requireSession } from '../http.ts';

export const unlockRoute = new Hono<AppEnv>()
  .use('*', requireSession)
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
  .put('/unlock', async c => {
    const user = c.get('user');
    const body = await readJsonBody(c, FinalizeUnlockRequestSchema, 'unlock finalisation payload');
    if (!body.ok) return body.response;

    const now = Date.now();
    const { isNewVault, wrappedDek } = body.data;
    if (body.data.mode === 'password') {
      // `setPassword` is server-only in Better Auth, so the credential is created here for the session's own user.
      try {
        await createAuth(c.env).api.setPassword({
          body: { newPassword: body.data.authValue },
          headers: c.req.raw.headers,
        });
      } catch {
        return apiError(c, 400, 'BAD_REQUEST', 'Could not set the account password');
      }

      try {
        await finalizePasswordUnlock(c.env.DB, user.id, { isNewVault, wrappedDek, now });
        return c.json({ ok: true as const }, 200);
      } catch (err) {
        if (err instanceof VaultAlreadyExistsError)
          return apiError(c, 409, 'CONFLICT', err.message);
        throw err;
      }
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
  .delete('/', async c => {
    const user = c.get('user');
    await resetVault(c.env.DB, user.id);
    return c.json({ ok: true as const }, 200);
  });
