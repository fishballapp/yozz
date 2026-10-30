import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { reportFailure, UsageError } from '../errors.ts';

export const sendCommand = Command.make(
  'send',
  {
    draftId: Argument.String('draftId').pipe(
      Argument.withDescription('The versioned draftId the last `yozz draft` printed'),
    ),
  },
  () => reportFailure(Effect.fail(new UsageError({ message: '`yozz send` is not built yet' }))),
).pipe(
  Command.withShortDescription('Send exactly the draft version named'),
  Command.withDescription(`Send exactly the draft version named. Repeating it never sends twice: a send that
already went through answers "replayed": true. When nobody saw the mail server's answer, it fails
with SendUnconfirmed, and the person settles it in yozz.app.

Output:
  {
    "sent": true,
    "replayed": false,
    "messageId": "mid/<01JA001@fishball.ltd>",
    "threadId": "mid/<01J9XYZ@stripe.com>",
    "sentCopy": "stored",
    "url": "https://yozz.app/m/sent/t/…"
  }`),
  Command.withExamples([{ command: "yozz send '9b1deb4d3b7d4bad@1'", description: 'Send it' }]),
);
