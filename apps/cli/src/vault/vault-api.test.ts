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

const record = { id: 'r1', type: 'address', ciphertext: 'c2VhbGVk' };

const CALLS = {
  get: api => api.get('address', 'r1'),
  list: api => Array.fromAsync(api.list('address')),
  put: api => api.put(record, 2, { expect: 'revision', revision: 1 }),
  remove: api => api.remove('address', 'r1', 1),
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
});
