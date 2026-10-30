import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, expect, layer } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import { ADDRESS } from '../mail/mail-world.ts';
import { failureOf } from '../test-world.ts';
import { makeComposeWorld } from './compose-world.ts';

layer(NodeServices.layer)(it => {
  describe('yozz discard', () => {
    it.effect(
      'tombstones the draft for 30 days, off every list, and it can no longer be sent',
      () =>
        Effect.gen(function* () {
          const { smtp, run, drafts } = yield* makeComposeWorld();
          const { draft } = JSON.parse(
            (yield* run(['draft', '--from', ADDRESS, '--to', 'kate@example.com'])).stdout,
          );
          const key = draft.id.slice('draft/'.length);
          expect(
            JSON.parse((yield* run(['list', '--mailbox', 'drafts'])).stdout).threads,
          ).toHaveLength(1);

          const { exit, stdout, stderr } = yield* run(['discard', draft.draftId]);

          assert.isTrue(Exit.isSuccess(exit), stderr);
          // The test clock stands at 0.
          expect(JSON.parse(stdout)).toEqual({
            discarded: true,
            draftId: `${key}@2`,
            restorableUntil: '1970-01-31T00:00:00.000Z',
          });
          expect((yield* drafts)[key]?.deletedAt).toBe(0);
          expect(JSON.parse((yield* run(['list', '--mailbox', 'drafts'])).stdout).threads).toEqual(
            [],
          );

          const send = yield* run(['send', `${key}@2`]);
          expect(failureOf(send.stderr)).toMatchObject({ code: 'NotFound' });
          expect(smtp.commands).toEqual([]);
          const again = yield* run(['discard', `${key}@2`]);
          expect(failureOf(again.stderr)).toMatchObject({ code: 'NotFound' });
        }),
    );

    it.effect('refuses a version that moved on, naming the newest', () =>
      Effect.gen(function* () {
        const { run } = yield* makeComposeWorld();
        const { draft } = JSON.parse((yield* run(['draft', '--from', ADDRESS])).stdout);
        const edited = JSON.parse(
          (yield* run(['draft', '--edit', draft.draftId, '--subject', 'Kept'])).stdout,
        ).draft;

        const stale = yield* run(['discard', draft.draftId]);

        expect(failureOf(stale.stderr)).toMatchObject({
          code: 'Conflict',
          currentDraftId: edited.draftId,
        });
      }),
    );
  });
});
