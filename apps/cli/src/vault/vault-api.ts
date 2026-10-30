import { type VaultApi, VaultApiError } from '@yozz.app/mail/vault/api';
import {
  ACCOUNT_HEADER,
  ApiErrorResponseSchema,
  ListRecordsResponseSchema,
  type VaultRecordEnvelope,
  VaultRecordEnvelopeSchema,
} from '@yozz.app/vault-contract';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import type * as Redacted from 'effect/Redacted';

/** What a refused request throws: every `VaultApi` throws `VaultApiError`, so a refused compare-and-swap reads the same in each client. */
const errorOf = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  const json = yield* response.json.pipe(Effect.option);
  const parsed = ApiErrorResponseSchema.safeParse(Option.getOrUndefined(json));
  return parsed.success
    ? new VaultApiError(parsed.data.error.code, parsed.data.error.message, response.status)
    : new VaultApiError(
        'INTERNAL_ERROR',
        `HTTP request failed with status ${response.status}`,
        response.status,
      );
});

/**
 * The vault's record routes for `client`, which already carries the CLI key's bearer and names its
 * account. The port is promises, so each call runs its own effect: the client needs nothing more.
 */
export const bearerVaultApi = (client: HttpClient.HttpClient): VaultApi => {
  const send = (request: HttpClientRequest.HttpClientRequest) =>
    client
      .execute(request)
      .pipe(
        Effect.mapError(
          error => new VaultApiError('NETWORK_ERROR', `Network error: ${error.message}`, 0),
        ),
      );
  const okJson = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(yield* errorOf(response));
    }
    return yield* response.json.pipe(Effect.orDie);
  });
  const recordPath = (type: string, id: string) =>
    `/api/v1/vault/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
  const run = <A>(effect: Effect.Effect<A, VaultApiError>) => Effect.runPromise(effect);

  /** The cursor is the recursion. */
  const list = async function* (type: string, after?: string): AsyncGenerator<VaultRecordEnvelope> {
    const page = await run(
      send(
        HttpClientRequest.get(`/api/v1/vault/records/${encodeURIComponent(type)}`, {
          urlParams: after === undefined ? {} : { after },
        }),
      ).pipe(Effect.flatMap(okJson)),
    );
    const { records, nextCursor } = ListRecordsResponseSchema.parse(page);
    yield* records;
    if (nextCursor !== null) yield* list(type, nextCursor);
  };

  return {
    get: (type, id) =>
      run(
        Effect.gen(function* () {
          const response = yield* send(HttpClientRequest.get(recordPath(type, id)));
          if (response.status === 404) return null;
          return VaultRecordEnvelopeSchema.parse(yield* okJson(response));
        }),
      ),
    list,
    put: (record, revision, precondition) =>
      run(
        send(
          HttpClientRequest.put(recordPath(record.type, record.id)).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              ciphertext: record.ciphertext,
              revision,
              ...(precondition === undefined ? {} : { precondition }),
            }),
          ),
        ).pipe(Effect.flatMap(okJson), Effect.asVoid),
      ),
    remove: (type, id, ifRevision) =>
      run(
        send(
          HttpClientRequest.make('DELETE')(recordPath(type, id), {
            urlParams: ifRevision === undefined ? {} : { ifRevision: String(ifRevision) },
          }),
        ).pipe(Effect.flatMap(okJson), Effect.asVoid),
      ),
  };
};

/** `client` on the API, with the key's bearer, naming its account. */
export const withCliKey =
  ({
    apiUrl,
    token,
    userId,
  }: {
    readonly apiUrl: string;
    readonly token: Redacted.Redacted<string>;
    readonly userId: string;
  }) =>
  (client: HttpClient.HttpClient) =>
    HttpClient.mapRequest(client, request =>
      request.pipe(
        HttpClientRequest.prependUrl(apiUrl),
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader(ACCOUNT_HEADER, userId),
      ),
    );
