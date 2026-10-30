import { DRAFT_TOMBSTONE_MS, parseDraftId } from '@yozz.app/mail/compose/draft-record';
import { deleteDraft } from '@yozz.app/mail/compose/draft-vault';
import * as Clock from 'effect/Clock';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import { DraftSending, NetworkError, NotFound, reportFailure, UsageError } from '../errors.ts';
import { printJson } from '../output.ts';
import { Vault } from '../vault/vault.ts';
import { DraftFiles } from './draft-files.ts';
import { conflictOf } from './drafts.ts';

/** What `discard` prints: the tombstone's id, and when it is erased. */
const discardedJson = (draftId: string, discardedAt: number) => ({
  discarded: true,
  draftId,
  restorableUntil: new Date(discardedAt + DRAFT_TOMBSTONE_MS).toISOString(),
});

export const discardCommand = Command.make(
  'discard',
  {
    draftId: Argument.String('draftId').pipe(
      Argument.withDescription('The versioned draftId the last `yozz draft` printed'),
    ),
  },
  Effect.fn('compose.discard')(function* ({ draftId }) {
    const parsed = parseDraftId(draftId);
    if (parsed === null) {
      return yield* new UsageError({
        message: `${draftId} is not a draftId: it is <key>@<version>, as yozz draft prints it`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const outcome = yield* (yield* Vault).use(store => deleteDraft(store, draftId, now));
    switch (outcome.outcome) {
      case 'absent':
        return yield* new NotFound({ message: `There is no draft ${draftId} to discard` });
      case 'sending':
        return yield* new DraftSending({
          message: `The draft ${draftId} is being sent, or waits for you to settle a send in yozz.app, so it can't be discarded`,
        });
      case 'conflict':
        return yield* conflictOf(draftId, outcome.currentDraftId);
      case 'offline':
        return yield* new NetworkError({
          message: 'The draft could not be discarded: YOZZ could not be reached',
        });
      case 'deleted':
        yield* (yield* DraftFiles).write(parsed.key, []);
        return yield* printJson(discardedJson(outcome.draftId, now));
    }
  }, reportFailure),
).pipe(
  Command.withShortDescription('Throw a draft away'),
  Command.withDescription(`Throw a draft away, as the composer's Discard does: it leaves every list at once, and is kept for 30 days (restorableUntil) before it is erased. Files it attached on this
machine are deleted.

A draft changed since that draftId is a Conflict naming its newest version (currentDraftId); one
whose send is in flight, or waits for you to settle it in yozz.app, is DraftSending.

Output:
  {
    "discarded": true,
    "draftId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d@3",
    "restorableUntil": "2026-11-29T09:41:07.000Z"
  }`),
  Command.withExamples([
    {
      command: "yozz discard '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d@2'",
      description: 'Discard it',
    },
  ]),
  Command.provide(DraftFiles.layer.pipe(Layer.provideMerge(Vault.layer))),
);
