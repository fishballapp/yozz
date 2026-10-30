import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Redacted from 'effect/Redacted';
import { Settings } from './settings.ts';
import {
  failureOf,
  type Homes,
  makeHomes,
  makeWorld,
  runCli,
  writeCredentials,
} from './test-world.ts';

const CREDENTIALS = {
  apiUrl: 'https://api.staging.yozz.test',
  userId: 'user_1',
  email: 'jason@fishball.ltd',
  keyId: 'key_1',
  token: 'yozzcli_file',
  privateKey: 'private',
};

const settingsUnder = (homes: Homes, env: Record<string, string> = {}) =>
  Settings.pipe(
    Effect.provide(Settings.layer),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ...homes, ...env }),
    ),
  );

layer(NodeServices.layer)(it => {
  describe('Settings', () => {
    it.effect('defaults to yozz.app with no login', () =>
      Effect.gen(function* () {
        const settings = yield* settingsUnder(yield* makeHomes);
        assert.strictEqual(settings.apiUrl, 'https://api.yozz.app');
        assert.strictEqual(settings.webUrl, 'https://yozz.app');
        assert.isTrue(Option.isNone(settings.login));
      }),
    );

    it.effect('reads the credentials file, with YOZZ_CLI_KEY and the URL variables over it', () =>
      Effect.gen(function* () {
        const homes = yield* makeHomes;
        yield* writeCredentials(homes, JSON.stringify(CREDENTIALS));

        const fromFile = yield* settingsUnder(homes);
        assert.strictEqual(fromFile.apiUrl, CREDENTIALS.apiUrl);
        const login = Option.getOrThrow(fromFile.login);
        assert.strictEqual(login.source, 'file');
        assert.strictEqual(Redacted.value(login.credentials.token), 'yozzcli_file');

        const fromEnv = yield* settingsUnder(homes, {
          YOZZ_CLI_KEY: JSON.stringify({ ...CREDENTIALS, token: 'yozzcli_env' }),
          YOZZ_API_URL: 'http://localhost:8787/',
          YOZZ_WEB_URL: 'http://localhost:5177',
        });
        const envLogin = Option.getOrThrow(fromEnv.login);
        assert.strictEqual(envLogin.source, 'env');
        assert.strictEqual(Redacted.value(envLogin.credentials.token), 'yozzcli_env');
        assert.strictEqual(fromEnv.apiUrl, 'http://localhost:8787');
        assert.strictEqual(fromEnv.webUrl, 'http://localhost:5177');
      }),
    );

    it.effect('writes the credentials owner-only, the secrets in the clear only on disk', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homes = yield* makeHomes;
        const path = yield* Path.Path;
        // A file and a dir others can read, from before.
        const file = yield* writeCredentials(homes, '{}');
        const dir = path.dirname(file);
        yield* fs.chmod(file, 0o644);
        yield* fs.chmod(dir, 0o755);
        const before = Option.getOrThrow((yield* fs.stat(file)).ino);
        const settings = yield* settingsUnder(homes, {
          YOZZ_CLI_KEY: JSON.stringify(CREDENTIALS),
        });
        const { credentials } = Option.getOrThrow(settings.login);
        assert.notInclude(JSON.stringify(credentials), 'yozzcli_file');

        yield* settings.saveCredentials(credentials);
        expect(JSON.parse(yield* fs.readFileString(file))).toEqual(CREDENTIALS);
        assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700);
        // Renamed into place: the old, readable file never held the secrets.
        assert.notStrictEqual(Option.getOrThrow((yield* fs.stat(file)).ino), before);
        expect(yield* fs.readDirectory(dir)).toEqual(['credentials.json']);
      }),
    );

    it.effect.each([
      ['not JSON', '{"token": "yozzcli_'],
      ['not credentials', '{"token": 42}'],
    ] as const)(
      'a credentials file that is %s fails naming it, and login never writes over it',
      ([, content]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const homes = yield* makeHomes;
          const { fetch, calls } = yield* makeWorld();
          const file = yield* writeCredentials(homes, content);

          for (const command of ['whoami', 'login']) {
            const { exit, stderr } = yield* runCli([command], { fetch, homes });
            assert.isTrue(Exit.isFailure(exit));
            expect(failureOf(stderr)).toEqual({
              code: 'UsageError',
              message: `Invalid credentials file (fix it, or delete it and log in again): ${file}`,
            });
          }
          assert.lengthOf(calls, 0);
          assert.strictEqual(yield* fs.readFileString(file), content);
        }),
    );

    it.effect.each([['../..'], [''], ['a/b'], ['.']] as const)(
      'refuses the user id %j, which would name a directory outside yozz/',
      ([userId]) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const world = yield* makeWorld();
          const homes = yield* makeHomes;
          const bystander = path.join(homes.XDG_STATE_HOME, 'keep');
          yield* fs.makeDirectory(homes.XDG_STATE_HOME, { recursive: true });
          yield* fs.writeFileString(bystander, 'mine');
          world.state.isRevoked = true;

          const { exit, stderr } = yield* runCli(['logout'], {
            fetch: world.fetch,
            homes,
            env: { YOZZ_CLI_KEY: JSON.stringify({ ...world.credentials, userId }) },
          });

          assert.isTrue(Exit.isFailure(exit));
          expect(failureOf(stderr)).toMatchObject({ code: 'UsageError' });
          assert.isTrue(yield* fs.exists(bystander));
          assert.lengthOf(world.calls, 0);
        }),
    );

    it.effect('a YOZZ_CLI_KEY that is not credentials fails without echoing it', () =>
      Effect.gen(function* () {
        const { fetch } = yield* makeWorld();
        const { stderr } = yield* runCli(['whoami'], {
          fetch,
          homes: yield* makeHomes,
          env: { YOZZ_CLI_KEY: 'yozzcli_leaked_secret' },
        });
        expect(failureOf(stderr)).toMatchObject({ code: 'UsageError' });
        assert.notInclude(stderr, 'leaked');
      }),
    );
  });
});
