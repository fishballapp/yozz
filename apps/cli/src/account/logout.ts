import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import { ApiError, NetworkError, NotLoggedIn, reportFailure } from '../errors.ts';
import { printJson } from '../output.ts';
import { Settings } from '../settings.ts';
import { revokeKey } from './revoke.ts';

export const logoutCommand = Command.make(
  'logout',
  {},
  Effect.fn('account.logout')(function* () {
    const settings = yield* Settings;
    const fs = yield* FileSystem.FileSystem;
    if (Option.isNone(settings.login)) {
      return yield* new NotLoggedIn({ message: 'Not logged in: there is no key to revoke' });
    }
    const { credentials, source } = settings.login.value;
    const { userId } = credentials;

    // Anything but a key revoked or gone already keeps the credentials, so a retry can still
    // revoke it.
    yield* revokeKey({ apiUrl: settings.apiUrl, credentials }).pipe(
      Effect.mapError(error =>
        error._tag === 'ApiError'
          ? new ApiError({ ...error, message: `${error.message}; nothing was deleted` })
          : new NetworkError({ message: `${error.message}; nothing was deleted` }),
      ),
    );

    yield* fs.remove(settings.stateDir(userId), { recursive: true, force: true });
    yield* fs.remove(settings.cacheDir(userId), { recursive: true, force: true });
    // A key from YOZZ_CLI_KEY is not the file's, which may hold another login.
    if (source === 'file') yield* settings.deleteCredentials;
    yield* printJson({ loggedOut: true });
  }, reportFailure),
).pipe(
  Command.withShortDescription('Revoke this CLI key, delete its cache and credentials'),
  Command.withDescription(`Revoke this CLI key on YOZZ, then delete what it left on this machine: the credentials file (unless the key came from YOZZ_CLI_KEY), the revision marks, the files attached
to drafts and the mail cache.

A key already revoked still logs out. When YOZZ cannot be reached, nothing is deleted, so running
it again can still revoke the key.

Output:
  { "loggedOut": true }`),
  Command.withExamples([{ command: 'yozz logout', description: 'Revoke and forget this key' }]),
);
