import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { failureOf, runCli } from '../test-world.ts';
import { makeFakeImapServer } from './fake-imap-server.ts';
import { ADDRESS, mail, makeMailWorld, minuteOf2026, SECOND, SECOND_HOST } from './mail-world.ts';

type Row = { readonly id: string };
const idsOf = (stdout: string): string[] => JSON.parse(stdout).threads.map(({ id }: Row) => id);
const QUIET = { text: 'Nothing to see.' };

layer(NodeServices.layer)(it => {
  const world = Effect.fnUntraced(function* () {
    const mailWorld = yield* makeMailWorld();
    const { world, homes, servers, server } = mailWorld;
    return {
      ...mailWorld,
      list: (...args: string[]) =>
        runCli(['list', ...args], { fetch: world.fetch, homes, servers }),
      searches: () =>
        server.commands
          .filter(command => command.startsWith('UID SEARCH'))
          .map(command => command.slice('UID SEARCH '.length)),
    };
  });

  describe('yozz list --query', () => {
    describe('finds a mail whose body holds nothing, by', () => {
      for (const [field, overrides, query] of [
        ['its subject', { subject: 'ICO contact information' }, 'ICO'],
        ['its sender’s name', { fromName: 'Acme' }, 'acme'],
        ['its sender’s address', { from: 'hello@acme.test' }, 'hello@acme.test'],
        ['its To', { to: 'invoice@example.test' }, 'invoice@example.test'],
        ['its Cc', { cc: ['copied@example.test'] }, 'copied@example.test'],
        ['its Reply-To', { replyTo: 'replies@example.test' }, 'replies@example.test'],
      ] as const) {
        it.effect(field, () =>
          Effect.gen(function* () {
            const { server, list } = yield* world();
            server.deliver('INBOX', mail(1, { ...QUIET, ...overrides }));
            server.deliver('INBOX', mail(2, QUIET));

            expect(idsOf((yield* list('--query', query)).stdout)).toEqual(['mid/<m1@stripe.com>']);
          }),
        );
      }

      it.effect('its Bcc, on Sent', () =>
        Effect.gen(function* () {
          const { server, list } = yield* world();
          server.deliver('Sent', mail(1, { ...QUIET, bcc: ['hidden@example.test'] }));
          server.deliver('Sent', mail(2, QUIET));

          expect(idsOf((yield* list('--query', 'hidden@example.test')).stdout)).toEqual([
            'mid/<m1@stripe.com>',
          ]);
        }),
      );

      it.effect('the name of an attachment this machine has synced', () =>
        Effect.gen(function* () {
          const { server, list } = yield* world();
          server.deliver(
            'INBOX',
            mail(1, {
              ...QUIET,
              attachments: [{ name: 'Invoice-0003.pdf', type: 'application/pdf', content: 'x' }],
            }),
          );
          server.deliver('INBOX', mail(2, QUIET));

          expect(idsOf((yield* list('--query', 'invoice-0003')).stdout)).toEqual([
            'mid/<m1@stripe.com>',
          ]);
        }),
      );
    });

    it.effect('sends one command per field, BCC only on Sent, and never OR', () =>
      Effect.gen(function* () {
        const { list, searches } = yield* world();
        yield* list('--query', 'needle');
        const fields = [
          'SUBJECT "needle"',
          'FROM "needle"',
          'TO "needle"',
          'CC "needle"',
          'HEADER "Reply-To" "needle"',
          'TEXT "needle"',
        ];
        // Inbox, Sent, Archive; Trash is left out, and drafts are no server's.
        expect(searches()).toEqual([...fields, ...fields, 'BCC "needle"', ...fields]);
      }),
    );

    it.effect('sends an operator’s own commands, dates first, and stops at an empty answer', () =>
      Effect.gen(function* () {
        const { server, list, searches } = yield* world();
        server.deliver('INBOX', mail(1, { from: 'a@acme.test', cc: ['b@acme.test'] }));

        yield* list(
          '--query',
          'in:inbox from:acme to:acme subject:Invoice after:2026-10-01 before:2026/11/01',
        );
        expect(searches()).toEqual([
          'BEFORE 1-Nov-2026',
          'SINCE 1-Oct-2026',
          'FROM "acme"',
          'SUBJECT "Invoice"',
          'TO "acme"',
          'CC "acme"',
        ]);

        const asked = searches().length;
        yield* list('--query', 'in:inbox from:nobody to:acme');
        expect(searches().slice(asked)).toEqual(['FROM "nobody"']);
      }),
    );

    it.effect('wants two terms in one message, not across a conversation', () =>
      Effect.gen(function* () {
        const { server, list } = yield* world();
        server.deliver('INBOX', mail(1, { text: 'alpha here' }));
        server.deliver(
          'INBOX',
          mail(2, {
            subject: 'Re: Invoice #1',
            inReplyTo: '<m1@stripe.com>',
            references: ['<m1@stripe.com>'],
            text: 'beta here',
          }),
        );
        server.deliver('INBOX', mail(3, { text: 'alpha and beta' }));

        expect(idsOf((yield* list('--query', 'alpha')).stdout)).toEqual([
          'mid/<m3@stripe.com>',
          'mid/<m1@stripe.com>',
        ]);
        expect(idsOf((yield* list('--query', 'alpha beta')).stdout)).toEqual([
          'mid/<m3@stripe.com>',
        ]);
      }),
    );

    it.effect('covers every folder but Trash, which only in:trash or in:anywhere reach', () =>
      Effect.gen(function* () {
        const { server, list } = yield* world();
        server.deliver('INBOX', mail(1, { text: 'word' }));
        server.deliver('Sent', mail(2, { text: 'word' }));
        server.deliver('Archive', mail(3, { text: 'word only-archived' }));
        server.deliver('Trash', mail(4, { text: 'word only-trashed' }));
        const found = (query: string) =>
          list('--query', query).pipe(Effect.map(r => idsOf(r.stdout)));

        expect(yield* found('word')).toEqual([
          'mid/<m3@stripe.com>',
          'mid/<m2@stripe.com>',
          'mid/<m1@stripe.com>',
        ]);
        expect(yield* found('only-archived')).toEqual(['mid/<m3@stripe.com>']);
        expect(yield* found('only-trashed')).toEqual([]);
        expect(yield* found('only-trashed in:trash')).toEqual(['mid/<m4@stripe.com>']);
        expect(yield* found('only-trashed in:anywhere')).toEqual(['mid/<m4@stripe.com>']);
        expect(yield* found('word in:archive')).toEqual(['mid/<m3@stripe.com>']);
      }),
    );

    it.effect('holds after: on or after the day and before: strictly before it', () =>
      Effect.gen(function* () {
        const { server, list } = yield* world();
        for (const n of [10, 11, 12]) server.deliver('INBOX', mail(n));
        const found = (query: string) =>
          list('--query', query).pipe(Effect.map(r => idsOf(r.stdout)));

        expect(yield* found('after:2026/10/11')).toEqual([
          'mid/<m12@stripe.com>',
          'mid/<m11@stripe.com>',
        ]);
        expect(yield* found('before:2026-10-11')).toEqual(['mid/<m10@stripe.com>']);
      }),
    );

    describe('is:unread and is:starred', () => {
      it.effect('alone reach past the cached window', () =>
        Effect.gen(function* () {
          const { server, list, searches } = yield* world();
          for (let n = 1; n <= 205; n += 1) {
            server.deliver(
              'INBOX',
              mail(n, { date: minuteOf2026(n) }),
              n === 1 ? ['\\Flagged'] : ['\\Seen'],
            );
          }
          expect(idsOf((yield* list('--query', 'in:inbox is:starred')).stdout)).toEqual([
            'mid/<m1@stripe.com>',
          ]);
          expect(searches()).toEqual(['FLAGGED']);
        }),
      );

      it.effect('must hold on the same message as the other terms', () =>
        Effect.gen(function* () {
          const { server, list, searches } = yield* world();
          server.deliver('INBOX', mail(1, { text: 'needle' }), ['\\Seen']);
          server.deliver(
            'INBOX',
            mail(2, {
              subject: 'Re: Invoice #1',
              inReplyTo: '<m1@stripe.com>',
              references: ['<m1@stripe.com>'],
              text: 'other',
            }),
          );
          server.deliver('INBOX', mail(3, { text: 'needle' }));

          // The first conversation is unread, but not its message that holds the word.
          expect(idsOf((yield* list('--query', 'in:inbox needle is:unread')).stdout)).toEqual([
            'mid/<m3@stripe.com>',
          ]);
          expect(searches()[0]).toBe('UNSEEN');
        }),
      );

      it.effect('together must hold on one message', () =>
        Effect.gen(function* () {
          const { server, list, searches } = yield* world();
          server.deliver('INBOX', mail(1), ['\\Seen', '\\Flagged']);
          server.deliver(
            'INBOX',
            mail(2, {
              subject: 'Re: Invoice #1',
              inReplyTo: '<m1@stripe.com>',
              references: ['<m1@stripe.com>'],
            }),
          );
          server.deliver('INBOX', mail(3), ['\\Flagged']);

          expect(idsOf((yield* list('--query', 'in:inbox is:unread is:starred')).stdout)).toEqual([
            'mid/<m3@stripe.com>',
          ]);
          expect(searches()).toEqual(['UNSEEN', 'FLAGGED']);
        }),
      );
    });

    it.effect(
      'names a mailbox’s mail whichever address it was sent to, and only that login’s',
      () =>
        Effect.gen(function* () {
          const { server, second, addSecond, list } = yield* world();
          yield* addSecond();
          server.deliver('INBOX', mail(1, { to: 'alias@fishball.ltd', text: 'needle' }));
          second.deliver('INBOX', mail(2, { to: SECOND, text: 'needle' }));

          expect(idsOf((yield* list('--query', `needle mailbox:${ADDRESS}`)).stdout)).toEqual([
            'mid/<m1@stripe.com>',
          ]);
          expect(second.commands.filter(command => command.startsWith('UID SEARCH'))).toEqual([]);
          expect(idsOf((yield* list('--query', 'needle')).stdout)).toEqual([
            'mid/<m2@stripe.com>',
            'mid/<m1@stripe.com>',
          ]);
        }),
    );

    it.effect('unions vault drafts when in scope, and asks no server for in:drafts', () =>
      Effect.gen(function* () {
        const { world: api, homes, servers, list, searches } = yield* world();
        const drafted = yield* runCli(
          [
            'draft',
            '--from',
            ADDRESS,
            '--to',
            'bo@example.test',
            '--subject',
            'Plans',
            '--text',
            'A draft needle',
          ],
          { fetch: api.fetch, homes, servers },
        );
        assert.isTrue(Exit.isSuccess(drafted.exit), drafted.stderr);

        const only = (yield* list('--query', 'needle in:drafts')).stdout;
        expect(idsOf(only)).toHaveLength(1);
        expect(searches()).toEqual([]);
        expect(idsOf((yield* list('--query', 'needle')).stdout)).toEqual(idsOf(only));
        expect(idsOf((yield* list('--query', 'needle in:inbox')).stdout)).toEqual([]);
        expect(idsOf((yield* list('--query', 'unrelated in:drafts')).stdout)).toEqual([]);
      }),
    );

    it.effect('answers a failed address from its cached match, and still lists it as failed', () =>
      Effect.gen(function* () {
        const { world: api, homes, servers, server, addSecond } = yield* world();
        yield* addSecond();
        const dropsSearch = makeFakeImapServer({
          username: SECOND,
          password: 'secret',
          quirks: { dropsOn: command => command.startsWith('UID SEARCH') },
        });
        server.deliver('INBOX', mail(1, { subject: 'needle first' }));
        dropsSearch.deliver('INBOX', mail(2, { to: SECOND, subject: 'needle second' }));
        dropsSearch.deliver('INBOX', mail(3, { to: SECOND, subject: 'other' }));

        const { stdout } = yield* runCli(['list', '--query', 'in:inbox subject:needle'], {
          fetch: api.fetch,
          homes,
          servers: { ...servers, [SECOND_HOST]: dropsSearch },
        });

        expect(idsOf(stdout)).toEqual(['mid/<m2@stripe.com>', 'mid/<m1@stripe.com>']);
        expect(JSON.parse(stdout).failed).toMatchObject([
          { address: SECOND, code: 'MailServerError' },
        ]);
      }),
    );

    it.effect('errors on the alias form rather than answering nothing', () =>
      Effect.gen(function* () {
        const { list } = yield* world();
        const { stderr } = yield* list('--query', 'needle mailbox:alias@fishball.ltd');
        expect(failureOf(stderr)).toMatchObject({
          code: 'UsageError',
          message: expect.stringContaining('alias@fishball.ltd has no mailbox'),
        });
      }),
    );
  });
});
