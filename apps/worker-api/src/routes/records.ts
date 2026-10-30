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
import { apiError, type CallerEnv, readJsonBody, requireCaller } from '../http.ts';

const RecordKeySchema = z.object({ type: RecordTypeSchema, id: BlindRecordIdSchema });

const readRecordKey = (c: Context<CallerEnv>) => {
  const parsed = RecordKeySchema.safeParse(c.req.param());
  return parsed.success
    ? parsed
    : {
        success: false as const,
        response: apiError(c, 400, 'BAD_REQUEST', 'Invalid type or id format'),
      };
};

/** A browser session or a CLI key: the records are what a CLI key exists to reach. */
export const recordsRoute = new Hono<CallerEnv>()
  .use('*', requireCaller)
  .get('/:type/:id', async c => {
    const key = readRecordKey(c);
    if (!key.success) return key.response;

    const { userId } = c.get('caller');
    const record = await getRecord(c.env.DB, userId, key.data.type, key.data.id);

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

    const { userId } = c.get('caller');
    const result = await listRecords(c.env.DB, userId, typeParsed.data, queryParsed.data.after);

    return c.json(result, 200);
  })
  .put('/:type/:id', async c => {
    const key = readRecordKey(c);
    if (!key.success) return key.response;

    const body = await readJsonBody(c, PutRecordRequestSchema, 'record payload');
    if (!body.ok) return body.response;

    const { userId } = c.get('caller');
    const stated = body.data.precondition;
    const precondition = ((): PutPrecondition | undefined => {
      if (stated === undefined) return undefined;
      if (stated.expect === 'absent') return 'create';
      return { ifRevision: stated.revision };
    })();
    try {
      await putRecord(
        c.env.DB,
        userId,
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

    const { userId } = c.get('caller');
    try {
      await deleteRecord(c.env.DB, userId, key.data.type, key.data.id, query.data.ifRevision);
      return c.json({ ok: true as const }, 200);
    } catch (err) {
      if (err instanceof RecordStaleError) {
        return apiError(c, 409, 'CONFLICT', 'Record revision is stale');
      }
      throw err;
    }
  });
