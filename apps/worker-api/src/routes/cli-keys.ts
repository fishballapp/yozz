import {
  CliKeyIdSchema,
  CliKeyWrapResponseSchema,
  CreateCliKeyRequestSchema,
  CreateCliKeyResponseSchema,
  ListCliKeysResponseSchema,
} from '@yozz.app/vault-contract';
import { Hono } from 'hono';
import { mintCliToken } from '../cli-token.ts';
import { createCliKey, deleteCliKey, listCliKeys, useCliKey } from '../db/cli-keys.ts';
import { sessionExists } from '../db/unlock.ts';
import type { RuntimeEnv } from '../env.ts';
import {
  apiError,
  readJsonBody,
  requireCaller,
  requireCliKey,
  requireFreshCaller,
  requireFreshSession,
  requireNamedAccount,
  requireSession,
} from '../http.ts';

/** Each route states who may call it: the bearer reaches its own wrap and its own removal, nothing else here. */
export const cliKeysRoute = new Hono<{ Bindings: RuntimeEnv }>()
  /** Approving a CLI: the DEK wrapped to its key. A fresh session, as adding a passkey needs. */
  .post('/cli-keys', requireSession, requireNamedAccount, requireFreshSession, async c => {
    const body = await readJsonBody(c, CreateCliKeyRequestSchema, 'CLI key');
    if (!body.ok) return body.response;

    const userId = c.get('user').id;
    const sessionId = c.get('session').id;
    const { keyId, token, tokenHash } = await mintCliToken();
    const isCreated = await createCliKey(c.env.DB, userId, {
      ...body.data,
      keyId,
      tokenHash,
      sessionId,
      now: Date.now(),
    });
    if (isCreated) return c.json(CreateCliKeyResponseSchema.parse({ keyId, token }), 200);

    if (!(await sessionExists(c.env.DB, sessionId, userId))) {
      return apiError(c, 401, 'UNAUTHORIZED', 'This session ended while the change was being made');
    }
    return apiError(c, 409, 'CONFLICT', 'This account has no vault to open');
  })
  .get('/cli-keys', requireSession, requireNamedAccount, async c =>
    c.json(
      ListCliKeysResponseSchema.parse({ keys: await listCliKeys(c.env.DB, c.get('user').id) }),
      200,
    ),
  )
  /** Revoking from Settings (a fresh session), or `yozz logout` with the key's own bearer. */
  .delete('/cli-keys/:keyId', requireCaller, requireFreshCaller, async c => {
    const caller = c.get('caller');
    const keyId = CliKeyIdSchema.safeParse(c.req.param('keyId'));
    if (!keyId.success) return apiError(c, 404, 'NOT_FOUND', 'CLI key not found');
    if (caller.kind === 'cli-key' && caller.keyId !== keyId.data) {
      return apiError(c, 403, 'FORBIDDEN', 'A CLI key can remove only itself');
    }

    // Not theirs and not there look the same.
    if (!(await deleteCliKey(c.env.DB, caller.userId, keyId.data))) {
      return apiError(c, 404, 'NOT_FOUND', 'CLI key not found');
    }
    return c.json({ ok: true as const }, 200);
  })
  /** What the CLI opens the vault with, on every run. */
  .get('/cli-key', requireCliKey, async c => {
    const { userId, keyId } = c.get('cliKey');
    const wrap = await useCliKey(c.env.DB, userId, { keyId, now: Date.now() });
    // Revoked between the bearer check and here.
    if (wrap === null) return apiError(c, 401, 'UNAUTHORIZED', 'Authentication required');
    return c.json(CliKeyWrapResponseSchema.parse(wrap), 200);
  });
