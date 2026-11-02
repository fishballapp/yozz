import { createExecutionContext, env } from 'cloudflare:test';
import {
  ACCOUNT_HEADER,
  ListFilesResponseSchema,
  MAX_FILE_CIPHERTEXT_BYTES,
  MAX_STORED_BYTES_PER_USER,
} from '@yozz.app/vault-contract';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { mintCliToken } from '../src/cli-token.ts';
import { deleteAllFileObjects, fileObjectKey } from '../src/db/files.ts';
import { applyMigrations } from './apply-migrations.ts';
import { settledRequest } from './settled-request.ts';

const FILE_A = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const FILE_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

type Person = { readonly userId: string; readonly auth: Record<string, string> };

const signIn = async (email: string): Promise<Person> => {
  let magicUrl = '';
  const app = createApp({
    emailSender: async mail => {
      magicUrl = mail.url;
    },
  });
  await app.request(
    'http://localhost/api/auth/sign-in/magic-link',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://yozz.app' },
      body: JSON.stringify({ email, name: email }),
    },
    env,
  );
  const verified = await app.request(magicUrl, { method: 'GET' }, env);
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (!user) throw new Error(`User not found for ${email}`);
  return {
    userId: user.id,
    auth: {
      Cookie: verified.headers.get('set-cookie') ?? '',
      Origin: 'https://yozz.app',
      [ACCOUNT_HEADER]: user.id,
    },
  };
};

const withCliKey = async ({ userId }: Person): Promise<Record<string, string>> => {
  const { keyId, token, tokenHash } = await mintCliToken();
  await env.DB.prepare(
    `INSERT INTO vault_cli_key (id, user_id, name, public_key, ephemeral_public_key, wrapped_dek, token_hash, created_at)
     VALUES (?, ?, 'box', 'pub', 'eph', 'wrap', ?, 1000)`,
  )
    .bind(keyId, userId, tokenHash)
    .run();
  return { Authorization: `Bearer ${token}`, [ACCOUNT_HEADER]: userId };
};

const call = (path: string, init: RequestInit, bindings: typeof env = env): Promise<Response> =>
  settledRequest(`http://localhost${path}`, init, bindings);

const filePath = (fileId: string) => `/api/v1/vault/files/${fileId}`;

const bytesOf = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

const put = (auth: Record<string, string>, fileId: string, bytes: Uint8Array<ArrayBuffer>) =>
  call(filePath(fileId), {
    method: 'PUT',
    headers: {
      ...auth,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });

const digestOf = async (bytes: BufferSource): Promise<string> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex();

const objectText = async (userId: string, fileId: string): Promise<string | null> => {
  const object = await env.FILES.get(fileObjectKey(userId, fileId));
  return object === null ? null : object.text();
};

const rowsOf = async (userId: string) =>
  (
    await env.DB.prepare('SELECT file_id, size FROM vault_file WHERE user_id = ? ORDER BY file_id')
      .bind(userId)
      .all<{ file_id: string; size: number }>()
  ).results;

/** A body written piece by piece has no length of its own, so only its header states one. */
const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: controller => {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const bucketFailing = (method: 'put' | 'delete') =>
  new Proxy(env.FILES, {
    get: (target, property) => {
      if (property === method) return () => Promise.reject(new Error('R2 is down'));
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

describe('the file routes', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  describe('storing and reading', () => {
    it('round-trips bytes above the JSON limit, under the user, counted by their size', async () => {
      const alice = await signIn('alice@example.com');
      const big = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);

      const stored = await put(alice.auth, FILE_A, big);
      expect(stored.status).toBe(200);
      expect(await stored.json()).toEqual({ ok: true });

      const read = await call(filePath(FILE_A), { headers: alice.auth });
      expect(read.status).toBe(200);
      expect(read.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(read.headers.get('Content-Length')).toBe(String(big.length));
      // Whole digests: comparing millions of elements one by one takes the test's whole timeout.
      expect(await digestOf(await read.arrayBuffer())).toEqual(await digestOf(big));
      expect(await env.FILES.head(`${alice.userId}/${FILE_A}`)).not.toBeNull();
      expect(await rowsOf(alice.userId)).toEqual([{ file_id: FILE_A, size: big.length }]);
    });

    it('answers 404 for a file that is not there', async () => {
      const alice = await signIn('alice@example.com');

      const read = await call(filePath(FILE_A), { headers: alice.auth });

      expect(read.status).toBe(404);
      expect(await read.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('never replaces a file', async () => {
      const alice = await signIn('alice@example.com');
      await put(alice.auth, FILE_A, bytesOf('first'));

      const again = await put(alice.auth, FILE_A, bytesOf('a longer second'));

      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: { code: 'CONFLICT' } });
      expect(await objectText(alice.userId, FILE_A)).toBe('first');
      expect(await rowsOf(alice.userId)).toEqual([{ file_id: FILE_A, size: 5 }]);
    });

    it('deletes object and row, and deleting nothing succeeds', async () => {
      const alice = await signIn('alice@example.com');
      await put(alice.auth, FILE_A, bytesOf('first'));

      for (const _ of [1, 2]) {
        const removed = await call(filePath(FILE_A), { method: 'DELETE', headers: alice.auth });
        expect(removed.status).toBe(200);
      }

      expect(await objectText(alice.userId, FILE_A)).toBeNull();
      expect(await rowsOf(alice.userId)).toEqual([]);
    });

    it('keeps the row when the bucket fails a delete, so the retry still counts it', async () => {
      const alice = await signIn('alice@example.com');
      await put(alice.auth, FILE_A, bytesOf('first'));

      const removed = await call(
        filePath(FILE_A),
        { method: 'DELETE', headers: alice.auth },
        { ...env, FILES: bucketFailing('delete') },
      );

      expect(removed.status).toBe(500);
      expect(await rowsOf(alice.userId)).toHaveLength(1);
    });

    it('lists pages in order, with what is used in all of them', async () => {
      const alice = await signIn('alice@example.com');
      const ids = Array.from({ length: 150 }, () => crypto.randomUUID()).sort();
      await env.DB.batch(
        ids.map(id =>
          env.DB.prepare(
            'INSERT INTO vault_file (user_id, file_id, size, created_at) VALUES (?, ?, 10, 1000)',
          ).bind(alice.userId, id),
        ),
      );

      const first = ListFilesResponseSchema.parse(
        await (await call('/api/v1/vault/files', { headers: alice.auth })).json(),
      );
      expect(first.files.map(({ id }) => id)).toEqual(ids.slice(0, 100));
      expect(first.nextCursor).toBe(ids[99]);
      expect(first.usedBytes).toBe(1500);
      expect(first.capBytes).toBe(MAX_STORED_BYTES_PER_USER);

      const second = ListFilesResponseSchema.parse(
        await (
          await call(`/api/v1/vault/files?after=${first.nextCursor}`, { headers: alice.auth })
        ).json(),
      );
      expect(second.files.map(({ id }) => id)).toEqual(ids.slice(100));
      expect(second.nextCursor).toBeNull();
      expect(second.files[0]).toEqual({ id: ids[100], size: 10, createdAt: 1000 });
    });
  });

  describe('the length of a body', () => {
    it('refuses a body with no Content-Length, and reserves nothing', async () => {
      const alice = await signIn('alice@example.com');

      const refused = await call(filePath(FILE_A), {
        method: 'PUT',
        headers: alice.auth,
        body: streamOf(bytesOf('of no stated length')),
      });

      expect(refused.status).toBe(411);
      expect(await rowsOf(alice.userId)).toEqual([]);
      expect(await objectText(alice.userId, FILE_A)).toBeNull();
    });

    it('refuses a Content-Length that is not a positive decimal', async () => {
      const alice = await signIn('alice@example.com');

      for (const length of ['0', '-1', '1e3', '0x10', '1.5']) {
        const refused = await call(filePath(FILE_A), {
          method: 'PUT',
          headers: { ...alice.auth, 'Content-Length': length },
          body: streamOf(bytesOf('x')),
        });
        expect(refused.status, length).toBe(411);
      }
      expect(await rowsOf(alice.userId)).toEqual([]);
    });

    it('stores nothing for a body of unknown length under a stated one, which R2 refuses', async () => {
      const alice = await signIn('alice@example.com');

      const refused = await call(filePath(FILE_A), {
        method: 'PUT',
        headers: { ...alice.auth, 'Content-Length': '14' },
        body: streamOf(bytesOf('only this much')),
      });

      expect(refused.status).toBe(500);
      expect(await rowsOf(alice.userId)).toEqual([]);
      expect(await objectText(alice.userId, FILE_A)).toBeNull();
    });

    for (const [what, statedLength] of [
      ['shorter', '100'],
      ['longer', '4'],
    ] as const) {
      it(`stores nothing for a body ${what} than it stated, so the count stays true`, async () => {
        const alice = await signIn('alice@example.com');

        const refused = await call(filePath(FILE_A), {
          method: 'PUT',
          headers: { ...alice.auth, 'Content-Length': statedLength },
          body: bytesOf('fourteen bytes'),
        });

        expect(refused.status).toBe(500);
        expect(await rowsOf(alice.userId)).toEqual([]);
        expect(await objectText(alice.userId, FILE_A)).toBeNull();
      });
    }

    it('removes the row when the bucket fails, so the room is not lost', async () => {
      const alice = await signIn('alice@example.com');
      const bytes = bytesOf('a body');

      const refused = await call(
        filePath(FILE_A),
        {
          method: 'PUT',
          headers: { ...alice.auth, 'Content-Length': String(bytes.length) },
          body: bytes,
        },
        { ...env, FILES: bucketFailing('put') },
      );

      expect(refused.status).toBe(500);
      expect(await rowsOf(alice.userId)).toEqual([]);
    });
  });

  describe('the limits', () => {
    const seedUsed = (userId: string, size: number) =>
      env.DB.prepare(
        'INSERT INTO vault_file (user_id, file_id, size, created_at) VALUES (?, ?, ?, 1000)',
      )
        .bind(userId, 'seeded-usage', size)
        .run();

    it('refuses one file over the limit by what it states, before reading it', async () => {
      const alice = await signIn('alice@example.com');

      const refused = await call(filePath(FILE_A), {
        method: 'PUT',
        headers: { ...alice.auth, 'Content-Length': String(MAX_FILE_CIPHERTEXT_BYTES + 1) },
        body: streamOf(bytesOf('x')),
      });

      expect(refused.status).toBe(413);
      expect(await refused.json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
      expect(await rowsOf(alice.userId)).toEqual([]);
    });

    it('takes a file that fills the cap exactly, and refuses one byte over it', async () => {
      const alice = await signIn('alice@example.com');
      await seedUsed(alice.userId, MAX_STORED_BYTES_PER_USER - 5);

      const over = await put(alice.auth, FILE_A, bytesOf('sixsix'));
      expect(over.status).toBe(413);
      expect(await over.json()).toMatchObject({ error: { code: 'STORAGE_FULL' } });
      expect(await objectText(alice.userId, FILE_A)).toBeNull();

      expect((await put(alice.auth, FILE_B, bytesOf('fives'))).status).toBe(200);
    });

    it('lets only one of two uploads at once take the room for one', async () => {
      const alice = await signIn('alice@example.com');
      await seedUsed(alice.userId, MAX_STORED_BYTES_PER_USER - 5);

      const answers = await Promise.all([
        put(alice.auth, FILE_A, bytesOf('fives')),
        put(alice.auth, FILE_B, bytesOf('fives')),
      ]);

      expect(answers.map(({ status }) => status).sort()).toEqual([200, 413]);
      const rows = await rowsOf(alice.userId);
      expect(rows.reduce((sum, { size }) => sum + size, 0)).toBe(MAX_STORED_BYTES_PER_USER);
    });

    it('counts each user on their own', async () => {
      const alice = await signIn('alice@example.com');
      const bob = await signIn('bob@example.com');
      await seedUsed(alice.userId, MAX_STORED_BYTES_PER_USER);

      expect((await put(bob.auth, FILE_A, bytesOf('fives'))).status).toBe(200);
    });
  });

  describe('another user’s file', () => {
    const twoUsers = async () => {
      const alice = await signIn('alice@example.com');
      const bob = await signIn('bob@example.com');
      await put(bob.auth, FILE_A, bytesOf('bob’s'));
      return { alice, bob };
    };

    const expectBobsIntact = async (bob: Person) => {
      expect(await objectText(bob.userId, FILE_A)).toBe('bob’s');
      expect((await rowsOf(bob.userId)).map(({ file_id }) => file_id)).toEqual([FILE_A]);
    };

    it('cannot be read', async () => {
      const { alice, bob } = await twoUsers();

      const read = await call(filePath(FILE_A), { headers: alice.auth });

      expect(read.status).toBe(404);
      await expectBobsIntact(bob);
    });

    it('cannot be listed, or counted', async () => {
      const { alice } = await twoUsers();

      const page = await (await call('/api/v1/vault/files', { headers: alice.auth })).json();

      expect(page).toMatchObject({ files: [], usedBytes: 0, nextCursor: null });
    });

    it('cannot be overwritten: the same id is a file of the uploader’s own', async () => {
      const { alice, bob } = await twoUsers();

      expect((await put(alice.auth, FILE_A, bytesOf('alice’s'))).status).toBe(200);

      expect(await objectText(alice.userId, FILE_A)).toBe('alice’s');
      await expectBobsIntact(bob);
    });

    it('cannot be deleted', async () => {
      const { alice, bob } = await twoUsers();

      const removed = await call(filePath(FILE_A), { method: 'DELETE', headers: alice.auth });

      expect(removed.status).toBe(200);
      await expectBobsIntact(bob);
    });

    it('cannot be reached through an id shaped like a path', async () => {
      const { alice, bob } = await twoUsers();
      const ids = [
        `..%2F${bob.userId}%2F${FILE_A}`,
        `%2E%2E%2F${bob.userId}%2F${FILE_A}`,
        `${bob.userId}%2F${FILE_A}`,
        '..%2F..%2F..%2Fetc%2Fpasswd',
        `${FILE_A}%2F`,
        `${FILE_A}%00`,
      ];

      for (const id of ids) {
        const read = await call(filePath(id), { headers: alice.auth });
        expect(read.status, `GET ${id}`).toBe(400);

        const written = await call(filePath(id), {
          method: 'PUT',
          headers: { ...alice.auth, 'Content-Length': '1' },
          body: bytesOf('x'),
        });
        expect(written.status, `PUT ${id}`).toBe(400);

        const removed = await call(filePath(id), { method: 'DELETE', headers: alice.auth });
        expect(removed.status, `DELETE ${id}`).toBe(400);
      }

      const listed = await call(`/api/v1/vault/files?after=${ids[0]}`, { headers: alice.auth });
      expect(listed.status).toBe(400);
      await expectBobsIntact(bob);
      expect(await rowsOf(alice.userId)).toEqual([]);
    });

    it('is refused when a session or a key names the other account', async () => {
      const { alice, bob } = await twoUsers();
      const key = await withCliKey(alice);

      for (const auth of [
        { ...alice.auth, [ACCOUNT_HEADER]: bob.userId },
        { ...key, [ACCOUNT_HEADER]: bob.userId },
      ]) {
        const read = await call(filePath(FILE_A), { headers: auth });
        expect(read.status).toBe(403);
        expect(await read.json()).toMatchObject({ error: { code: 'ACCOUNT_MISMATCH' } });
      }
      await expectBobsIntact(bob);
    });
  });

  describe('who reaches these routes', () => {
    /** Every route, in the order a file's life goes. */
    const everyRoute = (auth: Record<string, string>) => [
      () => put(auth, FILE_A, bytesOf('sealed')),
      () => call(filePath(FILE_A), { headers: auth }),
      () => call('/api/v1/vault/files', { headers: auth }),
      () => call(filePath(FILE_A), { method: 'DELETE', headers: auth }),
    ];

    it('lets a CLI key do all of it', async () => {
      const alice = await signIn('alice@example.com');
      const key = await withCliKey(alice);

      for (const route of everyRoute(key)) expect((await route()).status).toBe(200);
      expect(await rowsOf(alice.userId)).toEqual([]);
    });

    it('lets a browser session do all of it', async () => {
      const alice = await signIn('alice@example.com');

      for (const route of everyRoute(alice.auth)) expect((await route()).status).toBe(200);
    });

    it('refuses a signed-out caller and a forged key at every route', async () => {
      const alice = await signIn('alice@example.com');
      await put(alice.auth, FILE_A, bytesOf('alice’s'));
      const forged = `yozzcli_${crypto.randomUUID()}_${'A'.repeat(43)}`;

      const refusedCallers: readonly Record<string, string>[] = [
        { Origin: 'https://yozz.app', [ACCOUNT_HEADER]: alice.userId },
        { Authorization: `Bearer ${forged}`, [ACCOUNT_HEADER]: alice.userId },
        // A bad bearer is not rescued by the cookie beside it.
        { ...alice.auth, Authorization: `Bearer ${forged}` },
      ];
      for (const auth of refusedCallers) {
        for (const route of everyRoute(auth)) {
          const refused = await route();
          expect(refused.status).toBe(401);
          expect(await refused.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
        }
      }
      expect(await objectText(alice.userId, FILE_A)).toBe('alice’s');
    });
  });

  it('deleting a user’s objects spares a user whose id starts with theirs', async () => {
    await env.FILES.put(fileObjectKey('user', FILE_A), 'theirs');
    await env.FILES.put(fileObjectKey('user2', FILE_A), 'another’s');

    await deleteAllFileObjects(env.FILES, 'user');

    expect(await objectText('user', FILE_A)).toBeNull();
    expect(await objectText('user2', FILE_A)).toBe('another’s');
  });

  describe('a deletion while an upload is in flight', () => {
    /** Where one `put` waits, its row reserved, and where the deletion hands over to it. */
    const stalledUpload = () => {
      const reachedPut = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const bucket = new Proxy(env.FILES, {
        get: (target, property) => {
          if (property === 'put') {
            return async (key: string, value: ReadableStream) => {
              reachedPut.resolve();
              await released.promise;
              return target.put(key, value);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { bucket, reachedPut: reachedPut.promise, release: () => released.resolve() };
    };

    /** The bucket a deletion sees, running `during` once after the first call of `method`. */
    const bucketPausing = (method: 'delete' | 'list', during: () => Promise<unknown>) => {
      let hasRun = false;
      return new Proxy(env.FILES, {
        get: (target, property) => {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          if (property !== method) return value.bind(target);
          return async (...args: unknown[]) => {
            const answer = await value.apply(target, args);
            if (!hasRun) {
              hasRun = true;
              await during();
            }
            return answer;
          };
        },
      });
    };

    const objectKeys = async ({ userId }: Person) =>
      (await env.FILES.list({ prefix: `${userId}/` })).objects.map(({ key }) => key);

    const upload = (alice: Person, bucket: R2Bucket, bytes = bytesOf('in flight')) =>
      call(
        filePath(FILE_A),
        {
          method: 'PUT',
          headers: { ...alice.auth, 'Content-Length': String(bytes.length) },
          body: bytes,
        },
        { ...env, FILES: bucket },
      );

    /** Each deletion, and the bucket call after which it next holds the row or the rows. */
    const DELETIONS = [
      {
        name: 'deleting the file',
        firstStep: 'delete',
        run: (alice: Person, bindings: typeof env = env) =>
          call(filePath(FILE_A), { method: 'DELETE', headers: alice.auth }, bindings),
      },
      {
        name: 'resetting the vault',
        firstStep: 'list',
        run: (alice: Person, bindings: typeof env = env) =>
          call('/api/v1/vault', { method: 'DELETE', headers: alice.auth }, bindings),
      },
      {
        name: 'deleting the account',
        firstStep: 'list',
        run: (alice: Person, bindings: typeof env = env) =>
          call('/api/v1/account', { method: 'DELETE', headers: alice.auth }, bindings),
      },
    ] as const;

    for (const { name, firstStep, run } of DELETIONS) {
      it(`${name} wins over a put that lands after it: the upload is refused`, async () => {
        const alice = await signIn('alice@example.com');
        const { bucket, reachedPut, release } = stalledUpload();
        const uploading = upload(alice, bucket);
        await reachedPut;
        expect(await rowsOf(alice.userId)).toHaveLength(1);

        expect((await run(alice)).status).toBe(200);
        release();

        expect((await uploading).status).toBe(500);
        expect(await objectKeys(alice)).toEqual([]);
        expect(await rowsOf(alice.userId)).toEqual([]);
      });

      it(`${name} catches a put that lands after its first step, whose row check passed`, async () => {
        const alice = await signIn('alice@example.com');
        const { bucket, reachedPut, release } = stalledUpload();
        const uploading = upload(alice, bucket);
        await reachedPut;
        const pausing = bucketPausing(firstStep, async () => {
          release();
          expect((await uploading).status).toBe(200);
          expect(await objectKeys(alice)).toHaveLength(1);
        });

        expect((await run(alice, { ...env, FILES: pausing })).status).toBe(200);

        expect(await objectKeys(alice)).toEqual([]);
        expect(await rowsOf(alice.userId)).toEqual([]);
      });
    }

    it('counts a stalled upload out when its id was deleted and reused for a smaller file', async () => {
      const alice = await signIn('alice@example.com');
      const { bucket, reachedPut, release } = stalledUpload();
      const uploading = upload(alice, bucket, bytesOf('the larger file'));
      await reachedPut;
      await call(filePath(FILE_A), { method: 'DELETE', headers: alice.auth });
      expect((await put(alice.auth, FILE_A, bytesOf('small'))).status).toBe(200);

      release();

      expect((await uploading).status).toBe(500);
      const [left] = (await env.FILES.list({ prefix: `${alice.userId}/` })).objects;
      const counted = (await rowsOf(alice.userId)).reduce((sum, { size }) => sum + size, 0);
      expect(left?.size ?? 0).toBeLessThanOrEqual(counted);
    });
  });

  it('keeps a wrong-sized upload counted when its object cannot be deleted', async () => {
    const alice = await signIn('alice@example.com');

    // Not `call`: its wait rethrows the failed clean-up, which a deployed Worker only logs.
    const refused = await createApp().request(
      `http://localhost${filePath(FILE_A)}`,
      {
        method: 'PUT',
        headers: { ...alice.auth, 'Content-Length': '4' },
        body: bytesOf('more than stated'),
      },
      { ...env, FILES: bucketFailing('delete') },
      createExecutionContext(),
    );

    expect(refused.status).toBe(500);
    expect(await objectText(alice.userId, FILE_A)).toBe('more than stated');
    expect(await rowsOf(alice.userId)).toEqual([{ file_id: FILE_A, size: 4 }]);
  });

  it('walks past a truncated page with no objects, by its cursor', async () => {
    await env.FILES.put(fileObjectKey('user', FILE_A), 'theirs');
    const cursors: (string | undefined)[] = [];
    const paging = new Proxy(env.FILES, {
      get: (target, property) => {
        if (property === 'list') {
          return async (options: R2ListOptions) => {
            cursors.push(options.cursor);
            if (cursors.length > 3) throw new Error('The walk is not moving');
            return options.cursor === undefined
              ? { objects: [], truncated: true, cursor: 'next', delimitedPrefixes: [] }
              : target.list({ prefix: options.prefix ?? '' });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await deleteAllFileObjects(paging, 'user');

    expect(cursors).toEqual([undefined, 'next']);
    expect(await objectText('user', FILE_A)).toBeNull();
  });

  describe('a vault reset', () => {
    const reset = (auth: Record<string, string>, bindings: typeof env = env) =>
      call('/api/v1/vault', { method: 'DELETE', headers: auth }, bindings);

    it('deletes the user’s objects and rows, and nobody else’s', async () => {
      const alice = await signIn('alice@example.com');
      const bob = await signIn('bob@example.com');
      await put(alice.auth, FILE_A, bytesOf('alice’s'));
      await put(bob.auth, FILE_A, bytesOf('bob’s'));

      expect((await reset(alice.auth)).status).toBe(200);

      expect(await objectText(alice.userId, FILE_A)).toBeNull();
      expect(await rowsOf(alice.userId)).toEqual([]);
      expect(await objectText(bob.userId, FILE_A)).toBe('bob’s');
      expect(await rowsOf(bob.userId)).toHaveLength(1);
    });

    it('keeps the rows when the bucket fails, and a retry finishes', async () => {
      const alice = await signIn('alice@example.com');
      await put(alice.auth, FILE_A, bytesOf('alice’s'));

      const failed = await reset(alice.auth, { ...env, FILES: bucketFailing('delete') });

      expect(failed.status).toBe(500);
      expect(await rowsOf(alice.userId)).toHaveLength(1);

      expect((await reset(alice.auth)).status).toBe(200);
      expect(await objectText(alice.userId, FILE_A)).toBeNull();
      expect(await rowsOf(alice.userId)).toEqual([]);
    });
  });
});
