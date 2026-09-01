import {
  BlindRecordIdSchema,
  DeleteRecordQuerySchema,
  ListRecordsQuerySchema,
  PutRecordRequestSchema,
  RecordTypeSchema,
} from '@yozz.app/vault-contract';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  deleteRecord,
  getRecord,
  listRecords,
  type PutPrecondition,
  putRecord,
  RecordConflictError,
  RecordStaleError,
} from '../db/records.ts';
import { type AppEnv, apiError, readJsonBody, requireSession } from '../http.ts';

const RecordKeySchema = z.object({ type: RecordTypeSchema, id: BlindRecordIdSchema });

/** The `/:type/:id` pair every single-record route addresses. */
const readRecordKey = (c: Context<AppEnv>) => {
  const parsed = RecordKeySchema.safeParse(c.req.param());
  return parsed.success
    ? parsed
    : {
        success: false as const,
        response: apiError(c, 400, 'BAD_REQUEST', 'Invalid type or id format'),
      };
};

export const recordsRoute = new Hono<AppEnv>()
  .use('*', requireSession)
  .get('/:type/:id', async c => {
    const key = readRecordKey(c);
    if (!key.success) return key.response;

    const user = c.get('user');
    const record = await getRecord(c.env.DB, user.id, key.data.type, key.data.id);

    if (!record) {
      return apiError(c, 404, 'NOT_FOUND', 'Record not found');
    }

    return c.json(record, 200);
  })
  .get('/:type', async c => {
    const typeParsed = RecordTypeSchema.safeParse(c.req.param('type'));
    if (!typeParsed.success) {
      return apiError(c, 400, 'BAD_REQUEST', 'Invalid record type');
    }

    const queryParsed = ListRecordsQuerySchema.safeParse(c.req.query());
    if (!queryParsed.success) {
      return apiError(c, 400, 'BAD_REQUEST', 'Invalid query parameters');
    }

    const user = c.get('user');
    const result = await listRecords(c.env.DB, user.id, typeParsed.data, queryParsed.data.after);

    return c.json(result, 200);
  })
  .put('/:type/:id', async c => {
    const key = readRecordKey(c);
    if (!key.success) return key.response;

    const body = await readJsonBody(c, PutRecordRequestSchema, 'record payload');
    if (!body.ok) return body.response;

    const user = c.get('user');
    const stated = body.data.precondition;
    const precondition: PutPrecondition | undefined =
      stated === undefined
        ? undefined
        : stated.expect === 'absent'
          ? 'create'
          : { ifRevision: stated.revision };
    try {
      await putRecord(
        c.env.DB,
        user.id,
        key.data.type,
        key.data.id,
        body.data.ciphertext,
        body.data.revision,
        Date.now(),
        precondition,
      );
      return c.json({ ok: true as const }, 200);
    } catch (err) {
      if (err instanceof RecordStaleError) {
        return apiError(c, 409, 'CONFLICT', 'Record revision is stale');
      }
      if (err instanceof RecordConflictError) {
        return apiError(c, 409, 'CONFLICT', err.message);
      }
      throw err;
    }
  })
  .delete('/:type/:id', async c => {
    const key = readRecordKey(c);
    if (!key.success) return key.response;

    const query = DeleteRecordQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return apiError(c, 400, 'BAD_REQUEST', 'Invalid query parameters');
    }

    const user = c.get('user');
    try {
      await deleteRecord(c.env.DB, user.id, key.data.type, key.data.id, query.data.ifRevision);
      return c.json({ ok: true as const }, 200);
    } catch (err) {
      if (err instanceof RecordStaleError) {
        return apiError(c, 409, 'CONFLICT', 'Record revision is stale');
      }
      throw err;
    }
  });
