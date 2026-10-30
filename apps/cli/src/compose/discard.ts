import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { reportFailure, UsageError } from '../errors.ts';

export const discardCommand = Command.make(
  'discard',
  {
    draftId: Argument.String('draftId').pipe(
      Argument.withDescription('The versioned draftId the last `yozz draft` printed'),
    ),
  },
  () => reportFailure(Effect.fail(new UsageError({ message: '`yozz discard` is not built yet' }))),
).pipe(
  Command.withShortDescription('Throw a draft away'),
  Command.withDescription(`Throw a draft away, as the composer's Discard does.

Output:
  { "discarded": true, "draftId": "9b1deb4d3b7d4bad@2" }`),
  Command.withExamples([
    { command: "yozz discard '9b1deb4d3b7d4bad@2'", description: 'Discard it' },
  ]),
);
