import {
  FileIdSchema,
  ListFilesQuerySchema,
  MAX_FILE_CIPHERTEXT_BYTES,
  MAX_STORED_BYTES_PER_USER,
} from '@yozz.app/vault-contract';
import { type Context, Hono } from 'hono';
import { fileObjectKey, listFiles, removeFile, reserveFile, storeFileObject } from '../db/files.ts';
import { apiError, type CallerEnv, requireCaller } from '../http.ts';

const readFileId = (c: Context<CallerEnv>) => {
  const parsed = FileIdSchema.safeParse(c.req.param('fileId'));
  return parsed.success
    ? parsed
    : { success: false as const, response: apiError(c, 400, 'BAD_REQUEST', 'Invalid file id') };
};

const DECIMAL = /^[1-9][0-9]*$/;

/** A browser session or a CLI key, like the records: both clients send and read files. */
export const filesRoute = new Hono<CallerEnv>()
  .use('*', requireCaller)
  .get('/', async c => {
    const query = ListFilesQuerySchema.safeParse(c.req.query());
    if (!query.success) return apiError(c, 400, 'BAD_REQUEST', 'Invalid query parameters');

    const page = await listFiles(c.env.DB, c.get('caller').userId, query.data.after);
    return c.json({ ...page, capBytes: MAX_STORED_BYTES_PER_USER }, 200);
  })
  .get('/:fileId', async c => {
    const fileId = readFileId(c);
    if (!fileId.success) return fileId.response;

    const object = await c.env.FILES.get(fileObjectKey(c.get('caller').userId, fileId.data));
    if (object === null) return apiError(c, 404, 'NOT_FOUND', 'File not found');

    return c.body(object.body, 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    });
  })
  .put('/:fileId', async c => {
    const fileId = readFileId(c);
    if (!fileId.success) return fileId.response;

    const contentLength = c.req.header('Content-Length') ?? '';
    const { body } = c.req.raw;
    if (!DECIMAL.test(contentLength) || body === null) {
      return apiError(c, 411, 'BAD_REQUEST', 'A file is uploaded with its Content-Length');
    }
    const size = Number(contentLength);
    if (size > MAX_FILE_CIPHERTEXT_BYTES) {
      return apiError(c, 413, 'FILE_TOO_LARGE', 'This file is larger than one file may be');
    }

    const { userId } = c.get('caller');
    const reservation = await reserveFile(c.env.DB, {
      userId,
      fileId: fileId.data,
      size,
      now: Date.now(),
    });
    if (reservation === 'exists') {
      return apiError(c, 409, 'CONFLICT', 'A file is never replaced; upload it under a new id');
    }
    if (reservation === 'full') return apiError(c, 413, 'STORAGE_FULL', 'File storage is full');

    const stored = (async () => {
      try {
        await storeFileObject(c.env.FILES, c.env.DB, {
          userId,
          fileId: fileId.data,
          body,
          size,
        });
        return true;
      } catch {
        await removeFile(c.env.FILES, c.env.DB, userId, fileId.data);
        return false;
      }
    })();
    // A dropped connection cancels the request's work, and the reservation must still be released.
    c.executionCtx.waitUntil(stored);

    return (await stored)
      ? c.json({ ok: true as const }, 200)
      : apiError(c, 500, 'INTERNAL_ERROR', 'The file was not stored');
  })
  .delete('/:fileId', async c => {
    const fileId = readFileId(c);
    if (!fileId.success) return fileId.response;

    await removeFile(c.env.FILES, c.env.DB, c.get('caller').userId, fileId.data);
    return c.json({ ok: true as const }, 200);
  });
