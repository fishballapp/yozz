import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import { reportFailure, UsageError } from '../errors.ts';

export const updateCommand = Command.make(
  'update',
  {
    ids: Argument.String('id').pipe(
      Argument.withDescription('Up to 50 conversation or message ids from `yozz list`'),
      Argument.between(1, 50),
    ),
    read: Flag.Boolean('read').pipe(Flag.withDescription('Mark read'), Flag.withDefault(false)),
    unread: Flag.Boolean('unread').pipe(
      Flag.withDescription('Mark unread'),
      Flag.withDefault(false),
    ),
    star: Flag.Boolean('star').pipe(Flag.withDescription('Star'), Flag.withDefault(false)),
    unstar: Flag.Boolean('unstar').pipe(
      Flag.withDescription('Remove the star'),
      Flag.withDefault(false),
    ),
    move: Flag.Literals('move', ['inbox', 'archive', 'trash']).pipe(
      Flag.withDescription('Move every copy of the conversation'),
      Flag.optional,
    ),
  },
  () => reportFailure(Effect.fail(new UsageError({ message: '`yozz update` is not built yet' }))),
).pipe(
  Command.withShortDescription('Mark read or unread, star, or move conversations'),
  Command.withDescription(`Mark conversations read or unread, star or unstar them, or move them; only what
is given changes. When some fail, the error is PartialFailure and the rows still print on stdout,
each failed one with its own error.

Output:
  {
    "threads": [
      { "id": "mid/<01J9XYZ@stripe.com>", "isUnread": false, "isStarred": false, "mailboxes": ["archive"] }
    ],
    "syncedAt": { "jason@fishball.ltd": "2026-10-30T09:41:07.000Z" }
  }`),
  Command.withExamples([
    {
      command: "yozz update 'mid/<01J9XYZ@stripe.com>' --read --move archive",
      description: 'Read and archived',
    },
  ]),
);
