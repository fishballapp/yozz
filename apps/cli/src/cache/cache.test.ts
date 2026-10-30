import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { makeFakeImapServer } from '../mail/fake-imap-server.ts';
import { ADDRESS, inbound, mail, makeMailWorld } from '../mail/mail-world.ts';
import { failureOf, runCli, USER_ID } from '../test-world.ts';
import { accountCache } from './disk.ts';

const idsOf = (stdout: string): string[] =>
  JSON.parse(stdout).threads.map(({ id }: { id: string }) => id);

/** Every file under `dir`, by its path from there. */
const filesUnder = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(dir, { recursive: true });
    const files = yield* Effect.filter(names, name =>
      Effect.map(fs.stat(path.join(dir, name)), ({ type }) => type === 'File'),
    );
    return files.toSorted();
  });

layer(NodeServices.layer)(it => {
  describe('the mail cache on disk', () => {
    it.effect('holds nothing readable, owner-only, under the account', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { world, homes, server, servers } = yield* makeMailWorld();
        server.deliver(
          'INBOX',
          mail(1, { subject: 'Quarterly secrets', text: 'The code is 4821.' }),
        );
        yield* runCli(['read', 'mid/<m1@stripe.com>'], { fetch: world.fetch, homes, servers });

        const dir = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
        const files = yield* filesUnder(dir);
        // A file per folder the server has, the account's sync time, and the body read.
        expect(files.map(file => path.basename(file)).toSorted()).toEqual([
          'account.bin',
          'archive.bin',
          'inbox-100-1.bin',
          'inbox.bin',
          'sent.bin',
          'trash.bin',
        ]);
        for (const file of files) {
          const bytes = yield* fs.readFile(path.join(dir, file));
          const text = new TextDecoder('latin1').decode(bytes);
          for (const secret of ['Quarterly', '4821', 'stripe.com', 'jason@fishball.ltd']) {
            assert.notInclude(text, secret, `${file} holds ${secret}`);
          }
          assert.strictEqual((yield* fs.stat(path.join(dir, file))).mode & 0o777, 0o600);
        }
        // The account's directory is named by a digest, not the address.
        expect(files.every(file => !file.includes('@'))).toBe(true);
      }),
    );

    it.effect('drops a file that does not open and rebuilds it from the server', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { world, homes, server, servers } = yield* makeMailWorld();
        const list = () => runCli(['list'], { fetch: world.fetch, homes, servers });
        server.deliver('INBOX', mail(1));
        yield* list();
        const opened = server.connections();

        const dir = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
        const inbox = (yield* filesUnder(dir)).find(file => path.basename(file) === 'inbox.bin');
        if (inbox === undefined) throw new Error('no inbox file');
        const bytes = yield* fs.readFile(path.join(dir, inbox));
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
        yield* fs.writeFile(path.join(dir, inbox), bytes);

        // Still within two minutes of the last sync, but what it read is gone: it syncs again.
        const { exit, stdout } = yield* list();
        assert.isTrue(Exit.isSuccess(exit));
        expect(JSON.parse(stdout).threads.map(({ id }: { id: string }) => id)).toEqual([
          'mid/<m1@stripe.com>',
        ]);
        assert.strictEqual(server.connections(), opened + 1);
        // And the rebuilt file opens: the next list answers from the cache.
        yield* list();
        assert.strictEqual(server.connections(), opened + 1);
      }),
    );

    it.effect('opens only under this vault: a file moved to another slot does not open', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { world, homes, server, servers } = yield* makeMailWorld();
        server.deliver('INBOX', mail(1));
        server.deliver('Sent', mail(2, { from: 'jason@fishball.ltd', to: 'billing@stripe.com' }));
        yield* runCli(['list'], { fetch: world.fetch, homes, servers });
        const opened = server.connections();

        const dir = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
        const files = yield* filesUnder(dir);
        const sent = files.find(file => path.basename(file) === 'sent.bin');
        const inbox = files.find(file => path.basename(file) === 'inbox.bin');
        if (sent === undefined || inbox === undefined) throw new Error('no folder files');
        // Sealed under the same key, but bound to its own name.
        yield* fs.copyFile(path.join(dir, sent), path.join(dir, inbox));

        const { stdout } = yield* runCli(['list'], { fetch: world.fetch, homes, servers });
        expect(JSON.parse(stdout).threads.map(({ id }: { id: string }) => id)).toEqual([
          'mid/<m1@stripe.com>',
        ]);
        assert.strictEqual(server.connections(), opened + 1);
      }),
    );

    it.effect('drops the cache of a mailbox the address no longer reads', () =>
      Effect.gen(function* () {
        const { world, homes, server, servers } = yield* makeMailWorld();
        server.deliver('INBOX', mail(1));
        yield* runCli(['list'], { fetch: world.fetch, homes, servers });

        // The address now reads another server: nothing of the old one may show or be written to.
        const moved = makeFakeImapServer({ username: ADDRESS, password: 'secret' });
        moved.deliver('INBOX', mail(2));
        yield* world.putAddress(inbound(ADDRESS, 'imap.elsewhere.test'), 2);
        const { stdout } = yield* runCli(['list'], {
          fetch: world.fetch,
          homes,
          servers: { 'imap.elsewhere.test': moved },
        });
        expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>']);
      }),
    );

    it.effect(
      "binds a cached body to its folder's UIDVALIDITY, so a renumbered uid reads afresh",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { world, homes, server, servers } = yield* makeMailWorld();
          const read = () =>
            runCli(['read', 'mid/<m1@stripe.com>', '--sync'], {
              fetch: world.fetch,
              homes,
              servers,
            });
          server.deliver('INBOX', mail(1, { text: 'The first message.' }));
          yield* read();

          // The folder's file is lost, and the server renumbered the inbox: uid 1 is other mail now.
          const dir = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
          const inboxFile = (yield* filesUnder(dir)).find(
            file => path.basename(file) === 'inbox.bin',
          );
          if (inboxFile === undefined) throw new Error('no inbox file');
          yield* fs.remove(path.join(dir, inboxFile));
          const inbox = server.mailboxes.get('INBOX');
          if (inbox === undefined) throw new Error('no inbox');
          inbox.uidValidity += 1;
          inbox.messages = [];
          inbox.uidNext = 1;
          server.deliver('INBOX', mail(1, { text: 'Someone else entirely.' }));

          const { stdout } = yield* read();
          expect(JSON.parse(stdout).threads[0].messages[0].untrusted.text).toBe(
            'Someone else entirely.',
          );
        }),
    );

    it.effect('fails a write the disk refuses as a UsageError, not a defect', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const key = yield* Effect.promise(() =>
          crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
          ]),
        );
        const cache = yield* accountCache({ dir, key, account: ADDRESS });
        // Where the account's sync time goes, something the rename cannot replace.
        yield* fs.makeDirectory(path.join(dir, 'account.bin', 'in-the-way'), { recursive: true });

        const error = yield* Effect.flip(cache.setSyncedAt(0));
        expect(error).toMatchObject({
          _tag: 'UsageError',
          message: expect.stringContaining("The mail cache can't be written"),
        });
      }),
    );

    it.effect(
      'says on the error line when the disk refuses to read the cache, rather than dying',
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { world, homes, server, servers } = yield* makeMailWorld();
          server.deliver('INBOX', mail(1));
          yield* runCli(['list'], { fetch: world.fetch, homes, servers });
          const dir = path.join(homes.XDG_CACHE_HOME, 'yozz', USER_ID);
          const inboxFile = (yield* filesUnder(dir)).find(
            file => path.basename(file) === 'inbox.bin',
          );
          if (inboxFile === undefined) throw new Error('no inbox file');

          yield* fs.chmod(path.join(dir, inboxFile), 0o000);
          const unreadable = yield* runCli(['list'], { fetch: world.fetch, homes, servers });
          yield* fs.chmod(path.join(dir, inboxFile), 0o600);
          assert.isTrue(Exit.isFailure(unreadable.exit));
          expect(failureOf(unreadable.stderr)).toMatchObject({
            code: 'UsageError',
            message: expect.stringContaining("The mail cache can't be read"),
          });
        }),
    );
  });
});
