import { VaultApiError } from '@yozz.app/mail/vault/api';
import {
  createRecordStore,
  type RecordStore,
  VaultStoreDisagreementError,
} from '@yozz.app/mail/vault/record-store';
import { deriveCliKeys, openVault, VaultError } from '@yozz.app/vault';
import { CliKeyWrapResponseSchema } from '@yozz.app/vault-contract';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import {
  ApiError,
  KeyRevoked,
  NetworkError,
  NotLoggedIn,
  reportFailure,
  UsageError,
  VaultUnreadable,
} from '../errors.ts';
import { Settings } from '../settings.ts';
import { fileRevisionMarks } from './revision-marks.ts';
import { bearerVaultApi, withCliKey } from './vault-api.ts';

const RELOGIN = 'run `yozz login` again';

/** What a failed vault call means to the person at the terminal; anything else is a fault. */
export const toCliError = (cause: unknown) => {
  if (cause instanceof UsageError || cause instanceof VaultUnreadable) return cause;
  if (cause instanceof VaultApiError) {
    if (cause.code === 'NETWORK_ERROR') return new NetworkError({ message: cause.message });
    if (cause.status === 401) {
      return new KeyRevoked({ message: `This CLI key was revoked: ${RELOGIN}` });
    }
    return new ApiError({
      message: `The YOZZ API refused the request (${cause.code}): ${cause.message}`,
      status: cause.status,
    });
  }
  if (cause instanceof VaultError || cause instanceof VaultStoreDisagreementError) {
    return new VaultUnreadable({ message: cause.message });
  }
  return undefined;
};

export type Account = {
  readonly userId: string;
  readonly email: string;
  readonly keyId: string;
  readonly source: 'file' | 'env';
};

/** The vault, opened on this machine with the CLI key: no vault key is ever written to disk. */
export class Vault extends Context.Service<
  Vault,
  {
    readonly account: Account;
    /** `HKDF(DEK, "yozz-cli-cache")`: what the mail cache on this machine is sealed with. */
    readonly cacheKey: CryptoKey;
    /** Runs `f` over the record store, `@yozz.app/mail`'s port, with its failures as the CLI's errors. */
    readonly use: <A>(
      f: (records: RecordStore) => Promise<A>,
    ) => Effect.Effect<A, KeyRevoked | NetworkError | ApiError | UsageError | VaultUnreadable>;
  }
>()('@yozz.app/cli/Vault') {
  static readonly layer = Layer.effect(
    Vault,
    reportFailure(
      Effect.gen(function* () {
        const settings = yield* Settings;
        if (Option.isNone(settings.login)) {
          return yield* new NotLoggedIn({
            message: 'Not logged in: run `yozz login`, or set YOZZ_CLI_KEY',
          });
        }
        const { credentials, source } = settings.login.value;
        const { userId, email, keyId } = credentials;
        const client = withCliKey({ apiUrl: settings.apiUrl, token: credentials.token, userId })(
          yield* HttpClient.HttpClient,
        );

        const response = yield* client
          .get('/api/v1/vault/cli-key')
          .pipe(Effect.mapError(({ message }) => new NetworkError({ message })));
        if (response.status === 401) {
          return yield* new KeyRevoked({ message: `This CLI key was revoked: ${RELOGIN}` });
        }
        if (response.status !== 200) {
          return yield* new ApiError({
            message: `The YOZZ API answered ${response.status} to opening the vault`,
            status: response.status,
          });
        }
        const { ephemeralPublicKey, wrappedDek } = CliKeyWrapResponseSchema.parse(
          yield* response.json.pipe(Effect.orDie),
        );

        const vault = yield* Effect.tryPromise({
          try: async () =>
            openVault(
              await deriveCliKeys({
                privateKey: Redacted.value(credentials.privateKey),
                ephemeralPublicKey,
              }),
              wrappedDek,
            ),
          // A wrap of a DEK this vault no longer has: reset since the key was made.
          catch: () =>
            new KeyRevoked({ message: `This CLI key no longer opens the vault: ${RELOGIN}` }),
        });
        const records = createRecordStore({
          vault,
          api: bearerVaultApi(client),
          marks: yield* fileRevisionMarks(settings.stateDir(userId)),
        });

        return Vault.of({
          account: { userId, email, keyId, source },
          cacheKey: vault.localKey('yozz-cli-cache'),
          use: f =>
            Effect.tryPromise(() => f(records)).pipe(
              Effect.catchTag('UnknownError', ({ cause }) => {
                const error = toCliError(cause);
                return error === undefined ? Effect.die(cause) : Effect.fail(error);
              }),
            ),
        });
      }),
    ),
  );
}
