import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import { seal, writePrivateFile } from '../files.ts';
import { makeFakeImapServer } from '../mail/fake-imap-server.ts';
import { ADDRESS, inbound, mail, makeMailWorld, SECOND } from '../mail/mail-world.ts';
import { failureOf, makeHomes, runCli, USER_ID, writeCredentials } from '../test-world.ts';
import { mailboxCache } from './disk.ts';

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
    it.effect('holds nothing readable, owner-only, under the mailbox', () =>
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
        // A file per folder the server has, the sync time, the body read and the snapshot written.
        expect(files.map(file => path.basename(file)).toSorted()).toEqual([
          'account.bin',
          'archive.bin',
          'inbox-100-1.bin',
          'inbox.bin',
          'junk.bin',
          'sent.bin',
          'snapshot.bin',
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
        // The mailbox's directory is named by a digest, not the address.
        expect(files.every(file => !file.includes('@'))).toBe(true);
      }),
    );

    it.effect("a machine with no cache starts from the vault's snapshot and reads on from it", () =>
      Effect.gen(function* () {
        const { world, homes, server, servers } = yield* makeMailWorld();
        server.deliver('INBOX', mail(1));
        server.deliver('INBOX', mail(2));
        yield* runCli(['list'], { fetch: world.fetch, homes, servers });
        expect(yield* world.readRecords('cache-snapshot')).toHaveLength(1);
        expect(world.files.size).toBe(1);

        server.deliver('INBOX', mail(3));
        const laptop = yield* makeHomes;
        yield* writeCredentials(laptop, JSON.stringify(world.credentials));
        const before = server.commands.length;
        const { exit, stdout } = yield* runCli(['list'], {
          fetch: world.fetch,
          homes: laptop,
          servers,
        });

        assert.isTrue(Exit.isSuccess(exit));
        expect(idsOf(stdout).toSorted()).toEqual([
          'mid/<m1@stripe.com>',
          'mid/<m2@stripe.com>',
          'mid/<m3@stripe.com>',
        ]);
        // Incremental from the snapshot's marks: no folder is read by sequence number from scratch.
        const commands = server.commands.slice(before);
        expect(commands.filter(command => command.startsWith('FETCH '))).toEqual([]);
        expect(commands).toContainEqual(expect.stringMatching(/^UID FETCH 3:\* /u));
      }),
    );

    it.effect(
      'a machine with an old cache shows the newer list from the vault while its mail server refuses',
      () =>
        Effect.gen(function* () {
          const { world, homes, second, servers, addSecond, expireSecond } = yield* makeMailWorld();
          yield* addSecond();
          second.deliver('INBOX', mail(1));
          second.deliver('INBOX', mail(2));
          yield* runCli(['list'], { fetch: world.fetch, homes, servers });

          // Elsewhere, 1 is filed and 3 arrives; another machine syncs that and saves its list.
          const inbox = second.folders.get('INBOX');
          if (inbox === undefined) throw new Error('no INBOX');
          inbox.messages = inbox.messages.filter(({ uid }) => uid !== 1);
          second.deliver('INBOX', mail(3));
          // The first snapshot is older than the interval, so the other machine may replace it.
          const [saved] = (yield* world.readRecords('cache-snapshot')).filter(
            ({ naturalKey }) => naturalKey === SECOND,
          );
          if (saved === undefined) throw new Error('no snapshot of the second address');
          yield* world.putRecord({
            type: 'cache-snapshot',
            naturalKey: SECOND,
            revision: saved.revision,
            plaintext: JSON.stringify({ ...JSON.parse(saved.plaintext), writtenAt: 0 }),
          });
          const laptop = yield* makeHomes;
          yield* writeCredentials(laptop, JSON.stringify(world.credentials));
          yield* runCli(['list'], { fetch: world.fetch, homes: laptop, servers });

          // This machine's mail server now refuses it, so its list is the cache's alone.
          yield* expireSecond();
          const before = world.calls.length;
          const { exit, stdout, stderr } = yield* runCli(['list', '--sync'], {
            fetch: world.fetch,
            homes,
            servers,
          });

          assert.isTrue(Exit.isSuccess(exit), stderr);
          const out = JSON.parse(stdout);
          expect(idsOf(stdout).toSorted()).toEqual(['mid/<m2@stripe.com>', 'mid/<m3@stripe.com>']);
          // Both mailboxes restored from one listing of the records. The one record read on its
          // own is the writer's, after the first address's sync landed.
          const reads = world.calls
            .slice(before)
            .filter(
              ({ url, method }) => method === 'GET' && url.includes('/records/cache-snapshot'),
            );
          expect(reads.filter(({ url }) => url.endsWith('/records/cache-snapshot'))).toHaveLength(
            1,
          );
          expect(reads.filter(({ url }) => url.includes('/records/cache-snapshot/'))).toHaveLength(
            1,
          );
          expect(out.failed).toEqual([
            expect.objectContaining({ address: SECOND, code: 'MailServerError' }),
          ]);
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
          const inbox = server.folders.get('INBOX');
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

    it.effect('reads a body cached before the DKIM check as absent, and fetches it again', () =>
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
        const cache = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        const inbox = cache.mail.folder('inbox');
        yield* Effect.promise(() =>
          inbox.putSync({ name: 'INBOX', uidValidity: 100, lastUid: 1, complete: true }),
        );
        // A body as the CLI wrote it before it kept the signing domain: the verified From alone.
        const name = path.join('bodies', 'inbox-100-1.bin');
        yield* fs.makeDirectory(path.join(dir, 'bodies'), { recursive: true });
        const plaintext = new TextEncoder().encode(
          JSON.stringify({
            paragraphs: ['Old.'],
            hasTextPart: true,
            inlineImagesTruncated: false,
            attachments: [],
            verifiedFrom: 'a@x',
          }),
        );
        const content = yield* seal({
          key,
          additionalData: new TextEncoder().encode(
            JSON.stringify(['yozz-cli-cache', ADDRESS, name]),
          ),
          plaintext,
        });
        yield* writePrivateFile(path.join(dir, name), content);

        expect(yield* Effect.promise(() => inbox.getBody(1))).toBeNull();
        expect(yield* fs.exists(path.join(dir, name))).toBe(false);
        // A body with its DKIM record, verified or not, is kept.
        yield* Effect.promise(() =>
          inbox.putBody(1, {
            paragraphs: ['New.'],
            hasTextPart: true,
            htmlSaysMore: false,
            inlineImagesTruncated: false,
            attachments: [],
            dkim: null,
          }),
        );
        expect(yield* Effect.promise(() => inbox.getBody(1))).toMatchObject({
          paragraphs: ['New.'],
          dkim: null,
        });
      }),
    );

    it.effect('still opens a folder written before summaries carried names, for the upgrade', () =>
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
        // As the CLI wrote it: no names on the summary, nothing about them on the mark.
        const old = {
          sync: { name: 'INBOX', uidValidity: 100, lastUid: 1, complete: true },
          summaries: [
            {
              seq: 1,
              uid: 1,
              flags: ['\\Seen'],
              internalDate: null,
              size: 10,
              envelope: null,
              references: [],
              gmailThreadId: null,
            },
          ],
          previews: [{ uid: 1, paragraphs: ['Kept.'] }],
        };
        const content = yield* seal({
          key,
          additionalData: new TextEncoder().encode(
            JSON.stringify(['yozz-cli-cache', ADDRESS, 'inbox.bin']),
          ),
          plaintext: new TextEncoder().encode(JSON.stringify(old)),
        });
        yield* writePrivateFile(path.join(dir, 'inbox.bin'), content);

        const { mail: cache } = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        const inbox = cache.folder('inbox');
        expect(yield* Effect.promise(() => inbox.getSync())).toEqual(old.sync);
        expect(yield* Effect.promise(() => inbox.listSummaries())).toMatchObject([
          { uid: 1, attachmentNames: [] },
        ]);
        expect(yield* Effect.promise(() => inbox.listPreviews())).toEqual(old.previews);

        // And what the upgrade writes reads back from the disk.
        yield* Effect.promise(() =>
          inbox.updateSummaries([1], summary => ({ ...summary, attachmentNames: ['a.pdf'] })),
        );
        yield* Effect.promise(() => inbox.putSync({ ...old.sync, hasAttachmentNames: true }));
        const reopened = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        const again = reopened.mail.folder('inbox');
        expect(yield* Effect.promise(() => again.getSync())).toMatchObject({
          hasAttachmentNames: true,
        });
        expect(yield* Effect.promise(() => again.listSummaries())).toMatchObject([
          { attachmentNames: ['a.pdf'] },
        ]);
      }),
    );

    it.effect('files a found copy where a move took it, and forgets one sent nowhere known', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const key = yield* Effect.promise(() =>
          crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt',
          ]),
        );
        const { found } = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        const at = (folder: 'inbox' | 'archive', uid: number) => ({ folder, uidValidity: 7, uid });
        yield* found.remember([
          { messageId: '<a@x>', ...at('inbox', 1) },
          { messageId: '<b@x>', ...at('inbox', 2) },
          { messageId: '<c@x>', ...at('inbox', 3) },
        ]);

        expect(yield* found.refile([{ from: at('inbox', 9), to: at('archive', 1) }])).toBe(false);
        expect(
          yield* found.refile([
            { from: at('inbox', 1), to: at('archive', 40) },
            { from: at('inbox', 2), to: null },
          ]),
        ).toBe(true);
        const reopened = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        expect(yield* reopened.found.of(new Set(['<a@x>', '<b@x>', '<c@x>']))).toEqual([
          { messageId: '<a@x>', ...at('archive', 40) },
          { messageId: '<c@x>', ...at('inbox', 3) },
        ]);
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
        const cache = yield* mailboxCache({ dir, key, mailbox: ADDRESS });
        // Where the mailbox's sync time goes, something the rename cannot replace.
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
