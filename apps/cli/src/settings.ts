import { homedir } from 'node:os';
import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import type * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import type * as PlatformError from 'effect/PlatformError';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { reportFailure, UsageError } from './errors.ts';
import { writePrivateFile } from './files.ts';

const DEFAULT_API_URL = 'https://api.yozz.app';
const DEFAULT_WEB_URL = 'https://yozz.app';

/** What `yozz login` writes and `YOZZ_CLI_KEY` holds. The token alone cannot open the vault; with the private key it can. */
export const CredentialsSchema = Schema.Struct({
  apiUrl: Schema.String,
  /** One path segment (it names this account's state and cache dirs): a Better Auth id's shape. */
  userId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/u)),
  email: Schema.String,
  keyId: Schema.String,
  token: Schema.RedactedFromValue(Schema.String),
  /** PKCS #8, base64url: its public half is read back from it. */
  privateKey: Schema.RedactedFromValue(Schema.String),
});
export type Credentials = typeof CredentialsSchema.Type;

const CredentialsJsonSchema = Schema.fromJsonString(CredentialsSchema);

export type Login = {
  readonly credentials: Credentials;
  readonly source: 'file' | 'env';
};

export class Settings extends Context.Service<
  Settings,
  {
    /** `YOZZ_API_URL`, else the API the key was made on, else api.yozz.app. */
    readonly apiUrl: string;
    /** `YOZZ_API_URL`, else api.yozz.app: where a new key is made, paired with `webUrl`. */
    readonly loginApiUrl: string;
    /** `YOZZ_WEB_URL`, else yozz.app: where `login` sends the browser. */
    readonly webUrl: string;
    /** `YOZZ_CLI_KEY` over the credentials file. */
    readonly login: Option.Option<Login>;
    readonly credentialsFile: string;
    /** `$XDG_STATE_HOME/yozz/<userId>`: the revision marks. */
    readonly stateDir: (userId: string) => string;
    /** `$XDG_CACHE_HOME/yozz/<userId>`: the mail cache. */
    readonly cacheDir: (userId: string) => string;
    /** Owner-only, as it holds the key. */
    readonly saveCredentials: (
      credentials: Credentials,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly deleteCredentials: Effect.Effect<void, PlatformError.PlatformError>;
  }
>()('@yozz.app/cli/Settings') {
  static readonly layer = Layer.effect(
    Settings,
    reportFailure(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const files = yield* Effect.context<FileSystem.FileSystem | Path.Path | Crypto.Crypto>();
        const xdgHome = (name: string, fallback: string) =>
          Config.String(name).pipe(Config.withDefault(path.join(homedir(), fallback)));
        const configHome = yield* xdgHome('XDG_CONFIG_HOME', '.config');
        const stateHome = yield* xdgHome('XDG_STATE_HOME', path.join('.local', 'state'));
        const cacheHome = yield* xdgHome('XDG_CACHE_HOME', '.cache');
        const credentialsFile = path.join(configHome, 'yozz', 'credentials.json');

        const fromEnv = yield* Config.Redacted('YOZZ_CLI_KEY').pipe(Config.option);
        const login: Option.Option<Login> = Option.isSome(fromEnv)
          ? Option.some({ credentials: yield* decodeEnvCredentials(fromEnv.value), source: 'env' })
          : Option.map(yield* readCredentialsFile(credentialsFile), credentials => ({
              credentials,
              source: 'file' as const,
            }));

        const withoutSlash = (url: string) => url.replace(/\/+$/u, '');
        const envApiUrl = yield* Config.String('YOZZ_API_URL').pipe(Config.option);
        const apiUrl = Option.getOrElse(envApiUrl, () =>
          Option.match(login, {
            onNone: () => DEFAULT_API_URL,
            onSome: ({ credentials }) => credentials.apiUrl,
          }),
        );
        const webUrl = yield* Config.String('YOZZ_WEB_URL').pipe(
          Config.withDefault(DEFAULT_WEB_URL),
        );

        return Settings.of({
          apiUrl: withoutSlash(apiUrl),
          loginApiUrl: withoutSlash(Option.getOrElse(envApiUrl, () => DEFAULT_API_URL)),
          webUrl: withoutSlash(webUrl),
          login,
          credentialsFile,
          stateDir: userId => path.join(stateHome, 'yozz', userId),
          cacheDir: userId => path.join(cacheHome, 'yozz', userId),
          saveCredentials: Effect.fnUntraced(function* (credentials) {
            const text = yield* Schema.encodeEffect(CredentialsJsonSchema)(credentials).pipe(
              Effect.orDie,
            );
            yield* writePrivateFile(credentialsFile, `${text}\n`).pipe(
              Effect.provideContext(files),
            );
          }),
          deleteCredentials: fs.remove(credentialsFile, { force: true }),
        });
      }),
    ),
  );
}

/** Never echoes the value: it holds the key. */
const decodeEnvCredentials = (value: Redacted.Redacted<string>) =>
  Schema.decodeEffect(CredentialsJsonSchema)(Redacted.value(value)).pipe(
    Effect.mapError(
      () =>
        new UsageError({
          message: 'YOZZ_CLI_KEY is not a yozz credentials file (copy the whole file into it)',
        }),
    ),
  );

/** A missing file is no login; a corrupt one fails, so a login never writes over what it held. */
const readCredentialsFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
  );
  if (Option.isNone(text)) return Option.none<Credentials>();
  return yield* Schema.decodeEffect(CredentialsJsonSchema)(text.value).pipe(
    Effect.asSome,
    Effect.mapError(
      () =>
        new UsageError({
          message: `Invalid credentials file (fix it, or delete it and log in again): ${file}`,
        }),
    ),
  );
});
