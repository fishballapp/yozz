import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import { ApiError, NetworkError } from '../errors.ts';
import type { Credentials } from '../settings.ts';
import { withCliKey } from '../vault/vault-api.ts';

/**
 * Revokes the key in `credentials` with its own bearer, on `apiUrl`. A 401 or 404 means it is gone
 * already, which is what was asked; any other answer is an `ApiError`, and none a `NetworkError`.
 */
export const revokeKey = Effect.fn('account.revokeKey')(function* ({
  apiUrl,
  credentials: { token, userId, keyId },
}: {
  readonly apiUrl: string;
  readonly credentials: Credentials;
}) {
  const client = withCliKey({ apiUrl, token, userId })(yield* HttpClient.HttpClient);
  const { status } = yield* client
    .del(`/api/v1/vault/cli-keys/${encodeURIComponent(keyId)}`)
    .pipe(Effect.mapError(({ message }) => new NetworkError({ message })));
  if (status !== 200 && status !== 401 && status !== 404) {
    return yield* new ApiError({
      message: `The YOZZ API answered ${status} to revoking key ${keyId}`,
      status,
    });
  }
});
