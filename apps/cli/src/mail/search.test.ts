import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { runCli } from '../test-world.ts';
import { mail, makeMailWorld } from './mail-world.ts';

type Row = { readonly id: string };
const idsOf = (stdout: string): string[] => JSON.parse(stdout).threads.map(({ id }: Row) => id);

layer(NodeServices.layer)(it => {
  describe('yozz list --query', () => {
    it.effect('finds a mail by its subject or its sender when the body holds neither', () =>
      Effect.gen(function* () {
        const { world, homes, server, servers } = yield* makeMailWorld();
        const list = (...args: string[]) =>
          runCli(['list', ...args], { fetch: world.fetch, homes, servers });
        server.deliver(
          'INBOX',
          mail(1, { subject: 'ICO - your contact information', text: 'Nothing to see.' }),
        );
        server.deliver(
          'INBOX',
          mail(2, { from: 'hello@acme.test', fromName: 'Acme', text: 'Nothing to see.' }),
        );
        server.deliver('INBOX', mail(3, { text: 'Nothing to see.' }));

        const bySubject = yield* list('--query', 'ICO');
        expect(idsOf(bySubject.stdout)).toEqual(['mid/<m1@stripe.com>']);
        const bySender = yield* list('--query', 'acme');
        expect(idsOf(bySender.stdout)).toEqual(['mid/<m2@stripe.com>']);
      }),
    );
  });
});
