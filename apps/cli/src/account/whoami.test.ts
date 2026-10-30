import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import {
  API,
  EMAIL,
  failureOf,
  KEY_ID,
  makeHomes,
  makeWorld,
  runCli,
  USER_ID,
  writeCredentials,
} from '../test-world.ts';

const host = (host: string) => ({ host, port: 993, username: 'jason', password: 'secret' });

layer(NodeServices.layer)(it => {
  describe('yozz whoami', () => {
    it.effect('opens the vault with the key and lists every address it holds', () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        yield* writeCredentials(homes, JSON.stringify(world.credentials));
        yield* world.putAddress(
          {
            address: 'jason@fishball.ltd',
            senderName: 'Jason Yu',
            smtp: host('smtp.fishball.ltd'),
            imap: host('imap.fishball.ltd'),
          },
          1,
        );
        yield* world.putAddress(
          { address: 'noreply@fishball.ltd', smtp: host('smtp.fishball.ltd') },
          3,
        );

        const { exit, stdout } = yield* runCli(['whoami'], { fetch: world.fetch, homes });

        assert.isTrue(Exit.isSuccess(exit));
        expect(JSON.parse(stdout)).toEqual({
          email: EMAIL,
          userId: USER_ID,
          keyId: KEY_ID,
          source: 'file',
          addresses: [
            { address: 'jason@fishball.ltd', name: 'Jason Yu', receives: true },
            { address: 'noreply@fishball.ltd', receives: false },
          ],
        });
        // Every request is the key's, for its own account; no password leaves the vault.
        assert.isTrue(world.calls.every(({ url }) => url.startsWith(`${API}/api/v1/vault/`)));
        assert.notInclude(stdout, 'secret');
      }),
    );

    it.effect('reads YOZZ_CLI_KEY over the credentials file', () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        yield* writeCredentials(homes, JSON.stringify({ ...world.credentials, token: 'stale' }));

        const { stdout } = yield* runCli(['whoami'], {
          fetch: world.fetch,
          homes,
          env: { YOZZ_CLI_KEY: JSON.stringify(world.credentials) },
        });

        expect(JSON.parse(stdout)).toMatchObject({ source: 'env', addresses: [] });
      }),
    );

    it.effect('refuses a record older than one this machine has seen', () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        yield* writeCredentials(homes, JSON.stringify(world.credentials));
        const address = { address: 'jason@fishball.ltd', smtp: host('smtp.fishball.ltd') };
        yield* world.putAddress(address, 2);
        assert.isTrue(
          Exit.isSuccess((yield* runCli(['whoami'], { fetch: world.fetch, homes })).exit),
        );

        // The server replays the revision before it.
        yield* world.putAddress({ ...address, senderName: 'Old' }, 1);
        const { exit, stderr } = yield* runCli(['whoami'], { fetch: world.fetch, homes });

        assert.isTrue(Exit.isFailure(exit));
        expect(failureOf(stderr)).toMatchObject({
          code: 'VaultUnreadable',
          message: expect.stringContaining('behind the 2 this device has already seen'),
        });
      }),
    );

    it.effect('fails with NotLoggedIn without credentials, and KeyRevoked once revoked', () =>
      Effect.gen(function* () {
        const world = yield* makeWorld();
        const homes = yield* makeHomes;
        const loggedOut = yield* runCli(['whoami'], { fetch: world.fetch, homes });
        expect(failureOf(loggedOut.stderr)).toMatchObject({ code: 'NotLoggedIn' });
        assert.lengthOf(world.calls, 0);

        yield* writeCredentials(homes, JSON.stringify(world.credentials));
        world.state.isRevoked = true;
        const revoked = yield* runCli(['whoami'], { fetch: world.fetch, homes });
        assert.isTrue(Exit.isFailure(revoked.exit));
        expect(failureOf(revoked.stderr)).toEqual({
          code: 'KeyRevoked',
          message: 'This CLI key was revoked: run `yozz login` again',
        });
      }),
    );
  });
});
