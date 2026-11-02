import { assert, describe, expect, it } from '@effect/vitest';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as Layer from 'effect/Layer';
import { toCliError } from './vault.ts';
import { bearerVaultApi } from './vault-api.ts';

const ERRORS = {
  401: { code: 'UNAUTHORIZED', message: 'Authentication required' },
  409: { code: 'CONFLICT', message: 'The record moved on' },
  500: { code: 'INTERNAL_ERROR', message: 'Something broke' },
} as const;

/** The API over a Worker that answers every request with `status` and its error body. */
const apiAnswering = (status: keyof typeof ERRORS) =>
  Effect.gen(function* () {
    return bearerVaultApi(
      HttpClient.mapRequest(
        yield* HttpClient.HttpClient,
        HttpClientRequest.prependUrl('https://api.yozz.test'),
      ),
    );
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(
            FetchHttpClient.Fetch,
            (async () =>
              new Response(JSON.stringify({ error: ERRORS[status] }), {
                status,
                headers: { 'content-type': 'application/json' },
              })) as typeof globalThis.fetch,
          ),
        ),
      ),
    ),
  );

const FILE_ID = '6f9619ff-8b86-4011-b42d-00c04fc964ff';

const record = { id: 'r1', type: 'address', ciphertext: 'c2VhbGVk' };

const CALLS = {
  get: api => api.get('address', 'r1'),
  list: api => Array.fromAsync(api.list('address')),
  put: api => api.put(record, 2, { expect: 'revision', revision: 1 }),
  remove: api => api.remove('address', 'r1', 1),
  putFile: api => api.putFile(FILE_ID, new Uint8Array([1, 2, 3])),
  getFile: api => api.getFile(FILE_ID),
  listFiles: api => api.listFiles(),
  removeFile: api => api.removeFile(FILE_ID),
} satisfies Record<string, (api: ReturnType<typeof bearerVaultApi>) => Promise<unknown>>;

const EXPECTED = {
  401: { _tag: 'KeyRevoked' },
  409: { _tag: 'ApiError', status: 409 },
  500: { _tag: 'ApiError', status: 500 },
} as const;

describe('the bearer VaultApi', () => {
  for (const status of [401, 409, 500] as const) {
    for (const [name, call] of Object.entries(CALLS)) {
      it.effect(`${name} rejects a ${status}, and the CLI names it`, () =>
        Effect.gen(function* () {
          const api = yield* apiAnswering(status);
          const rejected = yield* Effect.promise(() =>
            call(api).then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.instanceOf(rejected, VaultApiError);
          assert.strictEqual(rejected.status, status);
          assert.strictEqual(rejected.code, ERRORS[status].code);
          expect(toCliError(rejected)).toMatchObject(EXPECTED[status]);
        }),
      );
    }
  }

  it.effect('sends a file as raw bytes, and reads one back the same', () =>
    Effect.gen(function* () {
      const seen: { url: string; contentType: string | null; bytes: number[] }[] = [];
      const api = yield* Effect.gen(function* () {
        return bearerVaultApi(
          HttpClient.mapRequest(
            yield* HttpClient.HttpClient,
            HttpClientRequest.prependUrl('https://api.yozz.test'),
          ),
        );
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, (async (input, init) => {
                const request = new Request(input, init);
                if (request.method === 'GET') return new Response(new Uint8Array([9, 8, 7]));
                const contentType = request.headers.get('content-type');
                const bytes = [...new Uint8Array(await request.arrayBuffer())];
                seen.push({ url: request.url, contentType, bytes });
                return new Response('{"ok":true}', {
                  headers: { 'content-type': 'application/json' },
                });
              }) as typeof globalThis.fetch),
            ),
          ),
        ),
      );

      yield* Effect.promise(() => api.putFile(FILE_ID, new Uint8Array([1, 2, 3])));
      const read = yield* Effect.promise(() => api.getFile(FILE_ID));

      assert.deepStrictEqual(seen, [
        {
          url: `https://api.yozz.test/api/v1/vault/files/${FILE_ID}`,
          contentType: 'application/octet-stream',
          bytes: [1, 2, 3],
        },
      ]);
      assert.deepStrictEqual(read, new Uint8Array([9, 8, 7]));
    }),
  );

  it.effect('names a download cut off mid-body a network error', () =>
    Effect.gen(function* () {
      const api = yield* Effect.gen(function* () {
        return bearerVaultApi(
          HttpClient.mapRequest(
            yield* HttpClient.HttpClient,
            HttpClientRequest.prependUrl('https://api.yozz.test'),
          ),
        );
      }).pipe(
        Effect.provide(
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(
                FetchHttpClient.Fetch,
                (async () =>
                  new Response(
                    new ReadableStream({
                      start: controller => controller.error(new TypeError('terminated')),
                    }),
                  )) as typeof globalThis.fetch,
              ),
            ),
          ),
        ),
      );

      const rejected = yield* Effect.promise(() =>
        api.getFile(FILE_ID).then(
          () => undefined,
          (error: unknown) => error,
        ),
      );

      assert.instanceOf(rejected, VaultApiError);
      assert.strictEqual(rejected.code, 'NETWORK_ERROR');
    }),
  );
});
