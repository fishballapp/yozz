import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import { SEARCH_QUIET_LIMIT_MS, SUMMARIES_QUIET_LIMIT_MS } from '@yozz.app/mail/connection';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as TestClock from 'effect/testing/TestClock';
import { makeComposeWorld } from '../compose/compose-world.ts';
import { failureOf, runCli } from '../test-world.ts';
import { type FakeImapServer, makeFakeImapServer } from './fake-imap-server.ts';
import { ADDRESS, IMAP_HOST, mail, makeMailWorld, minuteOf2026, SECOND } from './mail-world.ts';
import { QUIET_LIMIT_MS } from './servers.ts';

// What each command asks a mail server, counted: a slow server (Forward Email takes 25–178 s over a
// UID SEARCH) makes the number of commands what an agent waits on.

/** The commands `server` receives while `effect` runs, by verb (`UID SEARCH`, `SELECT`, …). */
const tally = <A, E, R>(server: FakeImapServer, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const from = server.commands.length;
    const result = yield* effect;
    const counts: Record<string, number> = {};
    for (const command of server.commands.slice(from)) {
      const [first = '', second = ''] = command.split(' ');
      const verb = first === 'UID' ? `UID ${second}` : first;
      counts[verb] = (counts[verb] ?? 0) + 1;
    }
    return { result, counts };
  });

/** Signing in and out, which every command that reaches a server does once. */
const SESSION = { AUTHENTICATE: 1, CAPABILITY: 1, LOGOUT: 1 };

/** 205 in the inbox, the oldest outside the cached window of 200 and the only one with the needle. */
const needleOutsideTheWindow = (server: FakeImapServer) => {
  for (let n = 1; n <= 205; n += 1) {
    server.deliver(
      'INBOX',
      mail(n, { date: minuteOf2026(n), text: n === 1 ? 'The needle.' : 'Hay.' }),
    );
  }
};

/**
 * A `list --wait` running in the background (10 seconds unless `args` says), and the commands it
 * sent before it first idled. `quirks` stage a misbehaving server; `before` runs first, on the same
 * machine.
 */
const waiting = Effect.fnUntraced(function* (
  args: readonly string[],
  {
    quirks,
    before,
  }: {
    readonly quirks?: Parameters<typeof makeFakeImapServer>[0]['quirks'];
    readonly before?: (
      server: FakeImapServer,
      run: (...args: string[]) => ReturnType<typeof runCli>,
    ) => Effect.Effect<unknown, never, Effect.Services<ReturnType<typeof runCli>>>;
  } = {},
) {
  const mailWorld = yield* makeMailWorld();
  const { world, homes } = mailWorld;
  const server =
    quirks === undefined
      ? mailWorld.server
      : makeFakeImapServer({ username: ADDRESS, password: 'secret', quirks });
  const servers = { ...mailWorld.servers, [IMAP_HOST]: server };
  const run = (...args: string[]) => runCli(args, { fetch: world.fetch, homes, servers });
  server.deliver('INBOX', mail(1));
  if (before !== undefined) yield* before(server, run);
  const startedAt = yield* Clock.currentTimeMillis;
  const fiber = yield* run(
    'list',
    ...(args.includes('--wait') ? [] : ['--wait', '10']),
    ...args,
  ).pipe(Effect.forkChild);
  yield* idled(server, 1);
  const beforeIdle = server.commands.slice(0, server.commands.indexOf('IDLE'));
  return { ...mailWorld, server, servers, run, fiber, beforeIdle, startedAt };
});

/** Until the server has heard `times` IDLEs. */
const idled = (server: FakeImapServer, times: number) =>
  Effect.sleep('20 millis').pipe(
    Effect.repeat({
      until: () => server.commands.filter(command => command === 'IDLE').length >= times,
    }),
  );

const searchesOf = (server: FakeImapServer) =>
  server.commands.filter(command => command.startsWith('UID SEARCH'));

const idsOf = (stdout: string): string[] =>
  JSON.parse(stdout).threads.map(({ id }: { id: string }) => id);

layer(NodeServices.layer)(it => {
  describe('round trips', () => {
    describe('a search hit outside the cached window', () => {
      for (const [command, args, expected] of [
        // The summary, and the body the read and the reply's quote need.
        ['read', ['read', 'mid/<m1@stripe.com>'], { SELECT: 1, 'UID FETCH': 2 }],
        // A write syncs the mailbox it writes first, however fresh: LIST, its six folders and their
        // flags, then the SELECT and the summary of the hit.
        [
          'update',
          ['update', 'mid/<m1@stripe.com>', '--star'],
          { LIST: 1, SELECT: 7, 'UID FETCH': 2, 'UID STORE': 1 },
        ],
        [
          'draft --reply',
          ['draft', '--reply', 'mid/<m1@stripe.com>', '--text', 'Thanks.'],
          { SELECT: 1, 'UID FETCH': 2 },
        ],
      ] as const) {
        it.effect(`${command} fetches it where list found it, and searches nothing`, () =>
          Effect.gen(function* () {
            const { server, run } = yield* makeComposeWorld();
            needleOutsideTheWindow(server);
            yield* run(['list', '--query', 'needle']);

            const { result, counts } = yield* tally(server, run(args));
            assert.isTrue(Exit.isSuccess(result.exit), result.stderr);
            expect(counts).toEqual({ ...SESSION, ...expected });
          }),
        );
      }

      it.effect('read --sync syncs the mailbox it was found in, so a reply since shows', () =>
        Effect.gen(function* () {
          const { server, run } = yield* makeComposeWorld();
          needleOutsideTheWindow(server);
          yield* run(['list', '--query', 'needle']);
          server.deliver(
            'INBOX',
            mail(206, {
              date: minuteOf2026(206),
              subject: 'Re: Invoice #1',
              inReplyTo: '<m1@stripe.com>',
              references: ['<m1@stripe.com>'],
            }),
          );

          const { exit, stdout, stderr } = yield* run(['read', '--sync', 'mid/<m1@stripe.com>']);
          assert.isTrue(Exit.isSuccess(exit), stderr);
          expect(
            JSON.parse(stdout).threads[0].messages.map(({ id }: { id: string }) => id),
          ).toEqual(['mid/<m1@stripe.com>', 'mid/<m206@stripe.com>']);
        }),
      );

      it.effect('moved, it shows where it went, and is read from there with no search', () =>
        Effect.gen(function* () {
          const { server, run } = yield* makeComposeWorld();
          needleOutsideTheWindow(server);
          yield* run(['list', '--query', 'needle']);
          const moved = yield* run(['update', 'mid/<m1@stripe.com>', '--move', 'archive']);
          assert.isTrue(Exit.isSuccess(moved.exit), moved.stderr);

          const archived = yield* run(['list', '--query', 'in:archive']);
          expect(idsOf(archived.stdout)).toEqual(['mid/<m1@stripe.com>']);
          const read = yield* tally(server, run(['read', 'mid/<m1@stripe.com>']));
          assert.isTrue(Exit.isSuccess(read.result.exit), read.result.stderr);
          expect(read.counts['UID SEARCH']).toBeUndefined();
        }),
      );

      it.effect('is searched for again once it has moved from where it was found', () =>
        Effect.gen(function* () {
          const { server, run } = yield* makeComposeWorld();
          needleOutsideTheWindow(server);
          yield* run(['list', '--query', 'needle']);
          // yozz.app archives it.
          const inbox = server.folders.get('INBOX');
          const [moved] = inbox?.messages.splice(0, 1) ?? [];
          if (moved === undefined) throw new Error('nothing to move');
          server.deliver('Archive', moved.message);

          const { result, counts } = yield* tally(server, run(['read', 'mid/<m1@stripe.com>']));
          assert.isTrue(Exit.isSuccess(result.exit), result.stderr);
          expect(JSON.parse(result.stdout).threads[0].messages[0].untrusted.text).toBe(
            'The needle.',
          );
          // Its Message-ID in each of the five folders, once what was remembered no longer held.
          expect(counts['UID SEARCH']).toBe(5);

          // Found again, it is remembered where it is now.
          const again = yield* tally(server, run(['read', 'mid/<m1@stripe.com>']));
          expect(again.counts['UID SEARCH']).toBeUndefined();
        }),
      );

      it.effect('asks a mailbox whose server failed once, and names it once', () =>
        Effect.gen(function* () {
          const { world, homes, server, second, servers, addSecond, expireSecond } =
            yield* makeMailWorld();
          yield* addSecond();
          server.deliver('INBOX', mail(1));
          for (let n = 2; n <= 206; n += 1) {
            second.deliver(
              'INBOX',
              mail(n, { date: minuteOf2026(n), text: n === 2 ? 'The needle.' : 'Hay.' }),
            );
          }
          const run = (...args: string[]) => runCli(args, { fetch: world.fetch, homes, servers });
          yield* run('list', '--query', 'needle');
          // Its password changes, so the hit found there can no longer be fetched, and both
          // mailboxes are due a sync.
          yield* expireSecond();
          yield* TestClock.adjust('3 minutes');

          const { result, counts } = yield* tally(second, run('read', 'mid/<m2@stripe.com>'));
          expect(failureOf(result.stderr)).toMatchObject({ code: 'NotFound' });
          expect(counts.AUTHENTICATE).toBe(1);
          const unread = yield* run('read', 'mid/<m1@stripe.com>', 'mid/<m2@stripe.com>');
          expect(
            JSON.parse(unread.stdout).failed.map(({ address }: { address: string }) => address),
          ).toEqual([SECOND]);
        }),
      );

      it.effect('an id nothing knows is still searched for in every folder', () =>
        Effect.gen(function* () {
          const { server, run } = yield* makeComposeWorld();
          needleOutsideTheWindow(server);
          yield* run(['list', '--query', 'needle']);

          const { result, counts } = yield* tally(server, run(['read', 'mid/<nope@x>']));
          expect(failureOf(result.stderr)).toMatchObject({ code: 'NotFound' });
          expect(counts['UID SEARCH']).toBe(5);
        }),
      );
    });

    describe('read and update', () => {
      it.effect('sync the mailbox holding the id, and leave the others alone', () =>
        Effect.gen(function* () {
          const { world, homes, server, second, servers, addSecond } = yield* makeMailWorld();
          yield* addSecond();
          server.deliver('INBOX', mail(1));
          second.deliver('INBOX', mail(2));
          const run = (...args: string[]) => runCli(args, { fetch: world.fetch, homes, servers });
          yield* run('list');
          yield* TestClock.adjust('3 minutes');

          const read = yield* tally(second, run('read', 'mid/<m1@stripe.com>'));
          assert.isTrue(Exit.isSuccess(read.result.exit), read.result.stderr);
          expect(read.counts).toEqual({});
          const update = yield* tally(second, run('update', 'mid/<m1@stripe.com>', '--star'));
          assert.isTrue(Exit.isSuccess(update.result.exit), update.result.stderr);
          expect(update.counts).toEqual({});
        }),
      );

      it.effect('sync every mailbox when the id is in no cache', () =>
        Effect.gen(function* () {
          const { world, homes, server, second, servers, addSecond } = yield* makeMailWorld();
          yield* addSecond();
          server.deliver('INBOX', mail(1));
          const run = (...args: string[]) => runCli(args, { fetch: world.fetch, homes, servers });
          yield* run('list');
          yield* TestClock.adjust('3 minutes');
          // It lands in the second mailbox, and the agent has its id from yozz.app.
          second.deliver('INBOX', mail(2));

          const { result, counts } = yield* tally(second, run('read', 'mid/<m2@stripe.com>'));
          assert.isTrue(Exit.isSuccess(result.exit), result.stderr);
          expect(counts).toMatchObject({ LIST: 1 });
          expect(counts['UID SEARCH']).toBeUndefined();
        }),
      );
    });

    describe('list --wait', () => {
      it.effect('selects the inbox and idles, then reads only what arrived', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber, beforeIdle } = yield* waiting(['--query', 'from:acme.test']);
            expect(beforeIdle).toEqual([
              expect.stringMatching(/^AUTHENTICATE /u),
              'CAPABILITY',
              'SELECT "INBOX"',
            ]);
            const woke = server.commands.length;
            server.deliver('INBOX', mail(2, { from: 'hello@acme.test' }));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>']);
            expect(server.commands.slice(woke)).toEqual([
              'DONE',
              'SELECT "INBOX"',
              expect.stringMatching(/^UID FETCH 2:\* /u),
              'LOGOUT',
            ]);
          }),
        ),
      );

      it.effect('waits on past mail that does not match, asking the server nothing', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber } = yield* waiting(['--query', 'from:acme.test']);
            server.deliver('INBOX', mail(2));
            yield* idled(server, 2);
            server.deliver('INBOX', mail(3, { from: 'hello@acme.test' }));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m3@stripe.com>']);
            expect(searchesOf(server)).toEqual([]);
          }),
        ),
      );

      it.effect('matches a word in what arrived without the server', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber } = yield* waiting(['--query', 'code']);
            server.deliver('INBOX', mail(2, { subject: 'Your code is 4821' }));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>']);
            expect(searchesOf(server)).toEqual([]);
          }),
        ),
      );

      it.effect('asks the server for a word only a body holds, in one command', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber } = yield* waiting(['--query', 'from:stripe.com 4821']);
            server.deliver('INBOX', mail(2, { text: 'Your code is 4821.' }));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>']);
            expect(searchesOf(server)).toEqual(['UID SEARCH TEXT "4821"']);
          }),
        ),
      );

      it.effect(
        'drops a body search still running at the deadline, and ends then',
        () =>
          TestClock.withLive(
            Effect.gen(function* () {
              const { server, fiber, startedAt } = yield* waiting(
                ['--wait', '2', '--query', '4821'],
                {
                  quirks: { searchDelayMs: 5_000 },
                },
              );
              server.deliver('INBOX', mail(2, { text: 'Your code is 4821.' }));

              const { exit, stderr } = yield* Fiber.join(fiber);
              assert.isTrue(Exit.isFailure(exit));
              expect(failureOf(stderr)).toMatchObject({ code: 'WaitTimedOut' });
              // Not the 5 seconds the search takes, nor a LOGOUT queued behind it.
              expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(4_000);
              // Nor is the search sent again on a fresh connection once nobody waits for it.
              yield* Effect.sleep('300 millis');
              expect(server.connections()).toBe(1);
              expect(server.openConnections()).toBe(0);
              expect(searchesOf(server)).toEqual(['UID SEARCH TEXT "4821"']);
            }),
          ),
        15_000,
      );

      it.effect(
        'ends at the deadline while idling on a connection gone silent',
        () =>
          TestClock.withLive(
            Effect.gen(function* () {
              const { server, fiber, startedAt } = yield* waiting(['--wait', '1'], {
                quirks: { goesSilent: 'idle' },
              });

              const { exit, stderr } = yield* Fiber.join(fiber);
              assert.isTrue(Exit.isFailure(exit));
              expect(failureOf(stderr)).toMatchObject({ code: 'WaitTimedOut' });
              // Not after a DONE and a LOGOUT nobody will ever answer.
              expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(3_000);
              expect(server.openConnections()).toBe(0);
            }),
          ),
        15_000,
      );

      it.effect(
        'ends at the deadline on a server that never greets',
        () =>
          TestClock.withLive(
            Effect.gen(function* () {
              const { world, homes } = yield* makeMailWorld();
              const mute = makeFakeImapServer({
                username: ADDRESS,
                password: 'secret',
                quirks: { goesSilent: 'greeting' },
              });
              const startedAt = yield* Clock.currentTimeMillis;
              const { exit, stderr } = yield* runCli(['list', '--wait', '1'], {
                fetch: world.fetch,
                homes,
                servers: { [IMAP_HOST]: mute },
              });
              assert.isTrue(Exit.isFailure(exit));
              expect(failureOf(stderr)).toMatchObject({ code: 'WaitTimedOut' });
              expect((yield* Clock.currentTimeMillis) - startedAt).toBeLessThan(3_000);
              expect(mute.connections()).toBe(1);
              // Ended, not left open mid-greeting to hold the process.
              expect(mute.openConnections()).toBe(0);
            }),
          ),
        15_000,
      );

      it.effect('ends at the deadline without selecting the inbox again', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber } = yield* waiting(['--wait', '1']);
            const { stderr } = yield* Fiber.join(fiber);
            expect(failureOf(stderr)).toMatchObject({ code: 'WaitTimedOut' });
            expect(server.commands.filter(command => command === 'SELECT "INBOX"')).toHaveLength(1);
          }),
        ),
      );

      it.effect('opens a dropped IDLE connection again and keeps waiting', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            let idles = 0;
            const { server, fiber } = yield* waiting([], {
              quirks: { dropsOn: command => command === 'IDLE' && ++idles === 1 },
            });
            yield* idled(server, 2);
            server.deliver('INBOX', mail(2));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>']);
          }),
        ),
      );

      it.effect("matches subject: on the new message's own subject, not its conversation's", () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { server, fiber } = yield* waiting(['--query', 'subject:"re: invoice"'], {
              before: (_server, run) => Effect.asVoid(run('list')),
            });
            server.deliver(
              'INBOX',
              mail(2, {
                subject: 'Re: Invoice #1',
                inReplyTo: '<m1@stripe.com>',
                references: ['<m1@stripe.com>'],
              }),
            );

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m1@stripe.com>']);
          }),
        ),
      );

      it.effect('takes old mail moved back into the inbox for old, not arrived', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const old = mail(0, { subject: 'Your code is 1111' });
            const { server, fiber } = yield* waiting([], {
              before: (server, run) =>
                Effect.gen(function* () {
                  server.deliver('Archive', old);
                  yield* run('list', '--query', 'in:archive');
                }),
            });
            // yozz.app unarchives it, then the mail being waited for lands.
            const archive = server.folders.get('Archive');
            if (archive === undefined) throw new Error('no archive');
            archive.messages = [];
            server.deliver('INBOX', old);
            yield* idled(server, 2);
            server.deliver('INBOX', mail(3, { subject: 'Your code is 4821' }));

            const { exit, stdout, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);
            expect(idsOf(stdout)).toEqual(['mid/<m3@stripe.com>']);
          }),
        ),
      );

      it.effect('leaves what arrived for the next read to sync in', () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const { world, homes, server, servers, fiber } = yield* waiting([]);
            server.deliver('INBOX', mail(2, { subject: 'Your code is 4821' }));
            const { exit, stderr } = yield* Fiber.join(fiber);
            assert.isTrue(Exit.isSuccess(exit), stderr);

            const run = (...args: string[]) => runCli(args, { fetch: world.fetch, homes, servers });
            const read = yield* run('read', 'mid/<m2@stripe.com>');
            assert.isTrue(Exit.isSuccess(read.exit), read.stderr);
            const listed = yield* tally(server, run('list'));
            expect(idsOf(listed.result.stdout)).toEqual([
              'mid/<m2@stripe.com>',
              'mid/<m1@stripe.com>',
            ]);
            // The read synced it in, so the list answers from the cache.
            expect(listed.counts).toEqual({});
          }),
        ),
      );
    });

    it.effect(
      'gives each UID SEARCH and summary FETCH the time a slow server takes, then limits it as before',
      () =>
        Effect.gen(function* () {
          const { world, homes, server, servers } = yield* makeMailWorld();
          server.deliver('INBOX', mail(1));
          yield* runCli(['list', '--query', 'from:acme.test'], {
            fetch: world.fetch,
            homes,
            servers,
          });
          const raised = server.quietLimits.filter((_, index) => index % 2 === 0);
          expect(server.quietLimits).toEqual(raised.flatMap(ms => [ms, QUIET_LIMIT_MS]));
          expect(searchesOf(server).length).toBeGreaterThan(0);
          expect(raised.filter(ms => ms === SEARCH_QUIET_LIMIT_MS)).toHaveLength(
            searchesOf(server).length,
          );
          // The first sync's window.
          expect(raised.filter(ms => ms !== SEARCH_QUIET_LIMIT_MS)).toEqual([
            SUMMARIES_QUIET_LIMIT_MS,
          ]);
        }),
    );
  });
});
