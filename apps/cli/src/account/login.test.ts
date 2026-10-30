import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, it, layer } from '@effect/vitest';
import { deriveApprovalKeys, pairingCode, sealCliLogin } from '@yozz.app/vault';
import { formatCliToken } from '@yozz.app/vault-contract';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as TestClock from 'effect/testing/TestClock';
import {
  API,
  credentialsFile,
  EMAIL,
  failureOf,
  KEY_ID,
  makeHomes,
  makeWorld,
  runCli,
  TOKEN,
  USER_ID,
  WEB,
  writeCredentials,
} from '../test-world.ts';
import { defaultKeyName } from './login.ts';

/** The key this login makes; the world's own key (`KEY_ID`) is the one a machine may already hold. */
const NEW_KEY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NEW_TOKEN = formatCliToken({ keyId: NEW_KEY_ID, secret: 'N'.repeat(43) });
const LOGIN = { token: NEW_TOKEN, userId: USER_ID, email: EMAIL };

/** `yozz login` running, the approve URL it opened, and the browser's way back to it. */
const startLogin = Effect.fnUntraced(function* ({
  args = [],
  env,
  storedKey = false,
}: {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string | undefined>;
  /** The credentials file holds the world's key already. */
  readonly storedKey?: boolean;
} = {}) {
  const world = yield* makeWorld();
  const homes = yield* makeHomes;
  if (storedKey) yield* writeCredentials(homes, JSON.stringify(world.credentials));
  const opened = yield* Deferred.make<string>();
  const login = yield* runCli(['login', ...args], {
    fetch: world.fetch,
    homes,
    browser: opened,
    ...(env === undefined ? {} : { env }),
  }).pipe(Effect.forkChild);
  const url = new URL(yield* Deferred.await(opened));
  const param = (name: string) => url.searchParams.get(name) ?? '';
  const callback = (query: Record<string, string>) =>
    HttpClient.get(`http://127.0.0.1:${param('port')}/callback?${new URLSearchParams(query)}`).pipe(
      Effect.map(({ status }) => status),
      Effect.provide(FetchHttpClient.layer),
    );
  /** What the approve page sends back for `state`, sealed to the key in the URL. */
  const approval = (state: string) =>
    Effect.promise(async () => {
      const keys = await deriveApprovalKeys(param('publicKey'));
      return {
        state: param('state'),
        ephemeralPublicKey: keys.ephemeralPublicKey,
        sealedLogin: await sealCliLogin(keys.tokenKey, { state, payload: LOGIN }),
      };
    });
  /** Approves this login as the page would, and waits for the command to end. */
  const approve = Effect.gen(function* () {
    assert.strictEqual(yield* callback(yield* approval(param('state'))), 200);
    return yield* Fiber.join(login);
  });
  return { login, url, param, callback, approval, approve, homes, world };
});

describe('defaultKeyName', () => {
  it('is the hostname, cut to 60 characters, or CLI when nothing is left', () => {
    expect(defaultKeyName('jason-mbp.local')).toBe('jason-mbp.local');
    expect(defaultKeyName('h'.repeat(80))).toBe('h'.repeat(60));
    expect(defaultKeyName('')).toBe('CLI');
    expect(defaultKeyName('   ')).toBe('CLI');
  });
});

layer(NodeServices.layer)(it => {
  // Each on its own clock: `layer(…)` shares one test clock, and a login waits three minutes on it.
  describe('yozz login', () => {
    it.effect('opens the approve page with this key, and keeps the login it hands back', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { login, url, param, callback, approval, homes } = yield* startLogin({
          args: ['--name', 'work laptop'],
        });
        assert.strictEqual(url.origin + url.pathname, `${WEB}/cli/approve`);
        assert.strictEqual(param('name'), 'work laptop');
        assert.match(param('state'), /^[A-Za-z0-9_-]{43}$/u);

        assert.strictEqual(yield* callback(yield* approval(param('state'))), 200);
        const { exit, stdout, stderr } = yield* Fiber.join(login);

        assert.isTrue(Exit.isSuccess(exit));
        expect(JSON.parse(stdout)).toEqual({
          email: EMAIL,
          keyId: NEW_KEY_ID,
          name: 'work laptop',
        });
        // The code the approve page shows is printed before the URL.
        const code = yield* Effect.promise(() => pairingCode(param('publicKey')));
        assert.include(stderr, `Pairing code: ${code}`);
        assert.include(stderr, url.toString());

        const file = yield* credentialsFile(homes);
        assert.strictEqual((yield* fs.stat(file)).mode & 0o777, 0o600);
        const saved = JSON.parse(yield* fs.readFileString(file));
        expect(saved).toEqual({
          apiUrl: API,
          userId: USER_ID,
          email: EMAIL,
          keyId: NEW_KEY_ID,
          token: NEW_TOKEN,
          privateKey: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('ignores a callback without this run’s state, and takes the real one', () =>
      Effect.gen(function* () {
        const { login, param, callback, approval } = yield* startLogin();
        const forged = { ...(yield* approval(param('state'))), state: 'x'.repeat(43) };
        assert.strictEqual(yield* callback(forged), 403);
        assert.strictEqual(yield* callback({ state: param('state') }), 403);

        assert.strictEqual(yield* callback(yield* approval(param('state'))), 200);
        assert.isTrue(Exit.isSuccess((yield* Fiber.join(login)).exit));
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('refuses a login sealed for another login’s state', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { login, callback, approval, homes } = yield* startLogin();
        const replayed = yield* approval('o'.repeat(43));
        assert.strictEqual(yield* callback(replayed), 400);

        const { exit, stderr } = yield* Fiber.join(login);
        assert.isTrue(Exit.isFailure(exit));
        expect(failureOf(stderr)).toMatchObject({ code: 'LoginFailed' });
        assert.isFalse(yield* fs.exists(yield* credentialsFile(homes)));
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('revokes the key the credentials file held, with its own bearer', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { approve, homes, world } = yield* startLogin({ storedKey: true });
        const { exit } = yield* approve;

        assert.isTrue(Exit.isSuccess(exit));
        const revoke = world.calls.find(({ method }) => method === 'DELETE');
        assert.strictEqual(revoke?.url, `${API}/api/v1/vault/cli-keys/${KEY_ID}`);
        assert.strictEqual(revoke?.headers.get('authorization'), `Bearer ${TOKEN}`);
        assert.strictEqual(revoke?.headers.get('yozz-account'), USER_ID);
        const saved = JSON.parse(yield* fs.readFileString(yield* credentialsFile(homes)));
        assert.strictEqual(saved.keyId, NEW_KEY_ID);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('still logs in when the old key cannot be revoked, and says so', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { approve, homes, world } = yield* startLogin({ storedKey: true });
        world.state.deleteStatus = 500;
        const { exit, stdout, stderr } = yield* approve;

        assert.isTrue(Exit.isSuccess(exit));
        expect(JSON.parse(stdout)).toMatchObject({ keyId: NEW_KEY_ID });
        assert.include(stderr, `the previous key (${KEY_ID}) was not revoked`);
        const saved = JSON.parse(yield* fs.readFileString(yield* credentialsFile(homes)));
        assert.strictEqual(saved.keyId, NEW_KEY_ID);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('never revokes a key from YOZZ_CLI_KEY', () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const { approve, world: loginWorld } = yield* startLogin({
          env: { YOZZ_CLI_KEY: JSON.stringify(world.credentials) },
        });
        assert.isTrue(Exit.isSuccess((yield* approve).exit));
        assert.lengthOf(loginWorld.calls, 0);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('makes the new key on YOZZ_API_URL or yozz.app, never the old login’s API', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The stored key was made on the test API; this login runs with no YOZZ_API_URL.
        const { approve, homes, world } = yield* startLogin({
          storedKey: true,
          env: { YOZZ_API_URL: undefined },
        });
        assert.isTrue(Exit.isSuccess((yield* approve).exit));

        const saved = JSON.parse(yield* fs.readFileString(yield* credentialsFile(homes)));
        assert.strictEqual(saved.apiUrl, 'https://api.yozz.app');
        // The old key is still revoked where it was made.
        const revoke = world.calls.find(({ method }) => method === 'DELETE');
        assert.strictEqual(revoke?.url, `${API}/api/v1/vault/cli-keys/${KEY_ID}`);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('fails with LoginDenied when the page is denied', () =>
      Effect.gen(function* () {
        const { login, param, callback } = yield* startLogin();
        assert.strictEqual(yield* callback({ state: param('state'), error: 'denied' }), 200);

        const { exit, stderr } = yield* Fiber.join(login);
        assert.isTrue(Exit.isFailure(exit));
        expect(failureOf(stderr)).toEqual({
          code: 'LoginDenied',
          message: 'Authorization was cancelled in the browser.',
        });
      }).pipe(Effect.provide(TestClock.layer())),
    );

    it.effect('fails with LoginTimedOut three minutes on', () =>
      Effect.gen(function* () {
        const { login } = yield* startLogin();
        yield* TestClock.adjust('3 minutes');

        const { exit, stderr } = yield* Fiber.join(login);
        assert.isTrue(Exit.isFailure(exit));
        expect(failureOf(stderr)).toMatchObject({ code: 'LoginTimedOut' });
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
