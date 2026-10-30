import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  addressRecordSchema,
} from '@yozz.app/mail/addresses/record';
import { createVault, deriveApprovalKeys, generateCliKeyPair, rewrapDek } from '@yozz.app/vault';
import { formatCliToken, type VaultRecordEnvelope } from '@yozz.app/vault-contract';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Console from 'effect/Console';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as PlatformError from 'effect/PlatformError';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import { CliLayer, cli } from './app.ts';
import { runCommand } from './output.ts';

// The CLI run in-process against a fake Worker that holds a real vault: the CLI key's wrap, its
// bearer, and address records sealed as the browser seals them.

export const API = 'https://api.yozz.test';
export const WEB = 'https://yozz.test';
export const USER_ID = 'user_1';
export const EMAIL = 'jason@fishball.ltd';
export const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const TOKEN = formatCliToken({ keyId: KEY_ID, secret: 'S'.repeat(43) });

export type Call = { readonly url: string; readonly method: string; readonly headers: Headers };

type StoredRecord = { readonly envelope: VaultRecordEnvelope; readonly naturalKey: string };

/** A vault with one CLI key approved, and the Worker routes the CLI calls. */
export const makeWorld = Effect.fnUntraced(function* () {
  const account = {
    encKey: yield* Effect.promise(() =>
      crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']),
    ),
  };
  const { vault, wrappedDek } = yield* Effect.promise(() => createVault(account));
  const cliKey = yield* Effect.promise(() => generateCliKeyPair());
  const approval = yield* Effect.promise(() => deriveApprovalKeys(cliKey.publicKey));
  const wrap = yield* Effect.promise(() => rewrapDek(account, approval, wrappedDek));

  const records = new Map<string, StoredRecord>();
  const calls: Call[] = [];
  const state = { isRevoked: false, deleteStatus: 200 };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const unauthorized = () =>
    json(401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const call = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    if (url.origin !== API) return json(404, {});
    const isKeyed =
      call.headers.get('authorization') === `Bearer ${TOKEN}` &&
      call.headers.get('yozz-account') === USER_ID;
    if (!isKeyed || state.isRevoked) return unauthorized();

    if (call.method === 'GET' && url.pathname === '/api/v1/vault/cli-key') {
      return json(200, {
        keyId: KEY_ID,
        ephemeralPublicKey: approval.ephemeralPublicKey,
        wrappedDek: wrap,
      });
    }
    if (call.method === 'DELETE' && url.pathname === `/api/v1/vault/cli-keys/${KEY_ID}`) {
      return json(state.deleteStatus, { ok: true });
    }
    // One record a page, so every listing follows the cursor.
    const listed = /^\/api\/v1\/vault\/records\/([a-z]+)$/u.exec(url.pathname)?.[1];
    if (call.method === 'GET' && listed !== undefined) {
      const ofType = [...records.values()]
        .map(({ envelope }) => envelope)
        .filter(({ type }) => type === listed)
        .toSorted((a, b) => a.id.localeCompare(b.id));
      const after = url.searchParams.get('after');
      const start = after === null ? 0 : ofType.findIndex(({ id }) => id === after) + 1;
      const page = ofType.slice(start, start + 1);
      return json(200, {
        records: page,
        nextCursor: start + 1 < ofType.length ? (page[0]?.id ?? null) : null,
      });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  }) as typeof globalThis.fetch;

  /** Seals `record` at `revision` as the browser would, replacing what the Worker held. */
  const putAddress = (record: AddressRecord, revision: number) =>
    Effect.promise(async () => {
      const plaintext = JSON.stringify(addressRecordSchema.parse(record));
      const sealed = await vault.encryptRecord({
        type: ADDRESS_RECORD_TYPE,
        naturalKey: record.address,
        revision,
        plaintext,
      });
      records.set(sealed.id, {
        naturalKey: record.address,
        envelope: { ...sealed, updatedAt: 0, revision },
      });
    });

  /** What `yozz login` would have written for this key. */
  const credentials = {
    apiUrl: API,
    userId: USER_ID,
    email: EMAIL,
    keyId: KEY_ID,
    token: TOKEN,
    privateKey: cliKey.privateKey,
  };

  return { fetch, calls, state, putAddress, credentials };
});

/** Fresh XDG homes, gone with the scope. */
export const makeHomes = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  return {
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  };
});
export type Homes = Effect.Success<typeof makeHomes>;

export const credentialsFile = (homes: Homes) =>
  Effect.map(Path.Path, path => path.join(homes.XDG_CONFIG_HOME, 'yozz', 'credentials.json'));

export const writeCredentials = Effect.fnUntraced(function* (homes: Homes, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* credentialsFile(homes);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, content);
  return file;
});

/**
 * A machine whose browser opener fails after handing `opened` the URL it was asked to open (its
 * last argument): the login goes on, as it prints the URL too.
 */
const browserOpening = (opened: Deferred.Deferred<string>) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(command =>
      Deferred.succeed(
        opened,
        ChildProcess.isStandardCommand(command) ? (command.args.at(-1) ?? '') : '',
      ).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'ChildProcess',
              method: 'spawn',
            }),
          ),
        ),
      ),
    ),
  );

/** Runs `yozz <args>` in-process: its exit, stdout and stderr. */
export const runCli = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  {
    fetch,
    homes,
    env = {},
    browser,
  }: {
    readonly fetch: typeof globalThis.fetch;
    readonly homes: Homes;
    /** `undefined` unsets one of the defaults below. */
    readonly env?: Record<string, string | undefined>;
    readonly browser?: Deferred.Deferred<string>;
  },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = yield* Effect.exit(runCommand(cli, { version: 'test' })(args)).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        CliLayer,
        browser === undefined ? Layer.empty : browserOpening(browser),
      ),
    ),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(
        Object.fromEntries(
          Object.entries({ ...homes, YOZZ_API_URL: API, YOZZ_WEB_URL: WEB, ...env }).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      ),
    ),
    Effect.provideService(Console.Console, {
      ...console,
      log: (...parts: unknown[]) => stdout.push(parts.join(' ')),
      error: (...parts: unknown[]) => stderr.push(parts.join(' ')),
    }),
  );
  return { exit, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
});

/** The `error` of the one failure line. */
export const failureOf = (stderr: string): unknown =>
  JSON.parse(stderr.split('\n').at(-1) ?? '').error;
