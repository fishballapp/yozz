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
import * as Stdio from 'effect/Stdio';
import * as Stream from 'effect/Stream';
import { CliLayer, cli } from './app.ts';
import { API, WEB } from './fake-worker.ts';
import { MailServers, type MailSocket } from './mail/servers.ts';
import { runCommand } from './output.ts';

// The CLI run in-process against the fake Worker.

export * from './fake-worker.ts';

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

/** A mail server in memory: the fake IMAP or SMTP server. */
type FakeServer = { readonly open: () => MailSocket };

/** Mail servers by host name, each in memory; any other host cannot be reached. `dns`: TXT records by name. */
const mailServersOf = (
  servers: Readonly<Record<string, FakeServer>>,
  dns: Readonly<Record<string, readonly string[]>>,
) =>
  Layer.succeed(
    MailServers,
    MailServers.of({
      lookupTxt: async name => dns[name] ?? [],
      open: async ({ host }) => {
        const server = servers[host];
        return server === undefined
          ? { ok: false, error: { kind: 'tls', detail: `getaddrinfo ENOTFOUND ${host}` } }
          : { ok: true, value: server.open() };
      },
    }),
  );

/** Runs `yozz <args>` in-process: its exit, stdout and stderr. */
export const runCli = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  {
    fetch,
    homes,
    env = {},
    browser,
    servers = {},
    dns = {},
    stdin,
    onStdout,
  }: {
    readonly fetch: typeof globalThis.fetch;
    readonly homes: Homes;
    /** `undefined` unsets one of the defaults below. */
    readonly env?: Record<string, string | undefined>;
    readonly browser?: Deferred.Deferred<string>;
    readonly servers?: Readonly<Record<string, FakeServer>>;
    /** TXT records by name, for the DKIM keys a sender check reads. */
    readonly dns?: Readonly<Record<string, readonly string[]>>;
    /** What the command reads on stdin. */
    readonly stdin?: string;
    /** Hears each stdout line as it prints, for a command that stays running after its answer. */
    readonly onStdout?: (line: string) => void;
  },
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = yield* Effect.exit(runCommand(cli, { version: 'test' })(args)).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
        CliLayer,
        mailServersOf(servers, dns),
        browser === undefined ? Layer.empty : browserOpening(browser),
        stdin === undefined
          ? Layer.empty
          : Stdio.layerTest({ stdin: Stream.make(new TextEncoder().encode(stdin)) }),
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
      log: (...parts: unknown[]) => {
        stdout.push(parts.join(' '));
        onStdout?.(parts.join(' '));
      },
      error: (...parts: unknown[]) => stderr.push(parts.join(' ')),
    }),
  );
  return { exit, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
});

/** The `error` of the one failure line. */
export const failureOf = (stderr: string): unknown =>
  JSON.parse(stderr.split('\n').at(-1) ?? '').error;
