import { hostname } from 'node:os';
import { approveInBrowser } from '@fishballapps/cli-login';
import { deriveCliKeys, generateCliKeyPair, openCliLogin, pairingCode } from '@yozz.app/vault';
import {
  CliKeyNameSchema,
  CliLoginCallbackSchema,
  CliTokenSchema,
  PASSKEY_NAME_MAX_LENGTH,
} from '@yozz.app/vault-contract';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { LoginFailed, reportFailure } from '../errors.ts';
import { printJson } from '../output.ts';
import { Settings } from '../settings.ts';
import { revokeKey } from './revoke.ts';

/** The sealed login in an approval, opened with this run's key; `None` for a request that is not one. */
const openApproval = Effect.fnUntraced(function* ({
  privateKey,
  state,
  query,
}: {
  readonly privateKey: string;
  readonly state: string;
  readonly query: Readonly<Record<string, string>>;
}) {
  const callback = CliLoginCallbackSchema.safeParse(query);
  if (!callback.success || !('sealedLogin' in callback.data)) return Option.none();
  const { ephemeralPublicKey, sealedLogin } = callback.data;
  const login = yield* Effect.tryPromise({
    try: async () =>
      openCliLogin((await deriveCliKeys({ privateKey, ephemeralPublicKey })).tokenKey, {
        state,
        sealedLogin,
      }),
    catch: () =>
      new LoginFailed({
        message:
          'The approval did not open with this login’s key. Run `yozz login` again, and approve only the URL it prints.',
      }),
  });
  return Option.some({ ...login, keyId: CliTokenSchema.parse(login.token).keyId });
});

/** The hostname, cut to the contract's limit; `CLI` when nothing is left. */
export const defaultKeyName = (hostname: string): string => {
  const name = hostname.slice(0, PASSKEY_NAME_MAX_LENGTH).trim();
  return name === '' ? 'CLI' : name;
};

export const loginCommand = Command.make(
  'login',
  {
    name: Flag.String('name').pipe(
      Flag.withDescription(
        `What yozz.app's Settings calls this key; defaults to this machine's hostname`,
      ),
      Flag.filter(
        name => CliKeyNameSchema.safeParse(name).success,
        () => `Expected: a name of 1 to ${PASSKEY_NAME_MAX_LENGTH} characters`,
      ),
      Flag.optional,
    ),
  },
  Effect.fn('account.login')(function* ({ name: nameFlag }) {
    const settings = yield* Settings;
    const name = Option.getOrElse(nameFlag, () => defaultKeyName(hostname())).trim();
    const pair = yield* Effect.promise(() => generateCliKeyPair());
    const code = yield* Effect.promise(() => pairingCode(pair.publicKey));
    yield* Console.error(`Pairing code: ${code}\nApprove only if yozz.app shows this same code.`);

    const login = yield* approveInBrowser({
      product: 'yozz',
      consentUrl: `${settings.webUrl}/cli/approve`,
      params: { publicKey: pair.publicKey, name },
      accept: ({ state, query }) => openApproval({ privateKey: pair.privateKey, state, query }),
    });
    yield* settings.saveCredentials({
      // The API that goes with the page that made this key, never the old login's.
      apiUrl: settings.loginApiUrl,
      userId: login.userId,
      email: login.email,
      keyId: login.keyId,
      token: Redacted.make(login.token),
      privateKey: Redacted.make(pair.privateKey),
    });
    // The key the file held is gone from this machine now, so nothing else would ever revoke it. One
    // from YOZZ_CLI_KEY is someone else's to manage.
    if (Option.isSome(settings.login) && settings.login.value.source === 'file') {
      const { credentials: previous } = settings.login.value;
      yield* revokeKey({ apiUrl: previous.apiUrl, credentials: previous }).pipe(
        Effect.catch(({ message }) =>
          Console.error(
            `Logged in, but the previous key (${previous.keyId}) was not revoked: ${message}. Revoke it in yozz.app's Settings.`,
          ),
        ),
      );
    }
    yield* printJson({ email: login.email, keyId: login.keyId, name });
  }, reportFailure),
).pipe(
  Command.withShortDescription('Approve this CLI from an unlocked yozz.app tab'),
  Command.withDescription(`Approve this CLI from an unlocked yozz.app tab, and keep its key on this machine.

Prints a pairing code and a URL on stderr, and opens the URL in the browser. Approve there only if
the page shows the same code. Waits up to three minutes, then writes the key to
$XDG_CONFIG_HOME/yozz/credentials.json (owner-only). For CI or a sandbox, put that file's contents
in YOZZ_CLI_KEY instead.

Logging in over a login from the credentials file revokes that file's key once the new one is
saved; if that fails, a warning goes to stderr and the login still succeeds. Fails with
LoginDenied when the page is denied, LoginTimedOut after three minutes.

Output:
  { "email": "jason@fishball.ltd", "keyId": "0f8fad5b-d9cb-469f-a165-70867728950e", "name": "jason-mbp" }`),
  Command.withExamples([
    { command: 'yozz login', description: 'Named after this machine' },
    { command: 'yozz login --name "CI runner"', description: 'With the name Settings shows' },
  ]),
);
