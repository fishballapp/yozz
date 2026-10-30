import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import {
  API,
  failureOf,
  type Homes,
  KEY_ID,
  makeHomes,
  makeWorld,
  runCli,
  USER_ID,
  writeCredentials,
} from '../test-world.ts';

/** A logged-in machine with revision marks and a mail cache on disk. */
const loggedIn = Effect.fnUntraced(function* (homes: Homes, credentials: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* writeCredentials(homes, JSON.stringify(credentials));
  const state = path.join(homes.XDG_STATE_HOME, 'yozz', USER_ID);
  const cache = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
  for (const dir of [state, cache]) {
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, 'data'), '{}');
  }
  return { file, state, cache };
});

layer(NodeServices.layer)(it => {
  describe('yozz logout', () => {
    it.effect('revokes the key with its own bearer, then deletes what it left here', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        const left = yield* loggedIn(homes, world.credentials);

        const { exit, stdout } = yield* runCli(['logout'], { fetch: world.fetch, homes });

        assert.isTrue(Exit.isSuccess(exit));
        expect(JSON.parse(stdout)).toEqual({ loggedOut: true });
        expect(world.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `DELETE ${API}/api/v1/vault/cli-keys/${KEY_ID}`,
        ]);
        for (const path of [left.file, left.state, left.cache]) {
          assert.isFalse(yield* fs.exists(path), path);
        }
      }),
    );

    it.effect('still clears this machine when the key was revoked already', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        const left = yield* loggedIn(homes, world.credentials);
        world.state.isRevoked = true;

        assert.isTrue(
          Exit.isSuccess((yield* runCli(['logout'], { fetch: world.fetch, homes })).exit),
        );
        assert.isFalse(yield* fs.exists(left.file));
      }),
    );

    it.effect('deletes nothing when YOZZ cannot revoke the key, so a retry still can', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        const left = yield* loggedIn(homes, world.credentials);
        world.state.deleteStatus = 500;

        const { exit, stderr } = yield* runCli(['logout'], { fetch: world.fetch, homes });

        assert.isTrue(Exit.isFailure(exit));
        expect(failureOf(stderr)).toEqual({
          code: 'ApiError',
          status: 500,
          message: `The YOZZ API answered 500 to revoking key ${KEY_ID}; nothing was deleted`,
        });
        assert.isTrue(yield* fs.exists(left.file));
        assert.isTrue(yield* fs.exists(left.state));
      }),
    );

    it.effect('keeps the credentials file when the key came from YOZZ_CLI_KEY', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        const left = yield* loggedIn(homes, { ...world.credentials, keyId: 'another' });

        yield* runCli(['logout'], {
          fetch: world.fetch,
          homes,
          env: { YOZZ_CLI_KEY: JSON.stringify(world.credentials) },
        });

        assert.isTrue(yield* fs.exists(left.file));
        assert.isFalse(yield* fs.exists(left.state));
      }),
    );
  });
});
