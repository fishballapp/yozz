import { connect } from 'node:net';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { assert, describe, layer } from '@effect/vitest';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as PlatformError from 'effect/PlatformError';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Redacted from 'effect/Redacted';
import * as TestClock from 'effect/testing/TestClock';
import { approveInBrowser, loginViaBrowser } from './index';

/** Opens a raw connection to the callback server and writes `head`: what it reads back, and a promise that settles when the server closes it. */
const rawConnection = (port: string, head: string) => {
  const socket = connect(Number(port), '127.0.0.1');
  const chunks: string[] = [];
  socket.setEncoding('utf8');
  socket.on('data', chunk => chunks.push(String(chunk)));
  const closed = new Promise<string>(resolve => socket.on('close', () => resolve(chunks.join(''))));
  socket.write(head);
  return { closed };
};

layer(NodeServices.layer)(it => {
  describe('the browser login', () => {
    /** A machine whose browser opener fails, after handing the URL it was asked to open (the
     * command's last argument) to `opened`: the login goes on, as its URL is printed too. */
    const failingOpener = (opened: Deferred.Deferred<string>) =>
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

    /** Starts the flow: the URL it opens, and the fiber that ends with the key. */
    const startLogin = Effect.gen(function* () {
      const opened = yield* Deferred.make<string>();
      const login = yield* loginViaBrowser({
        product: 'example.com',
        consentUrl: 'https://dash.example.com/cli-auth',
      }).pipe(Effect.provide(failingOpener(opened)), Effect.forkChild);
      const url = new URL(yield* Deferred.await(opened));
      assert.strictEqual(url.origin + url.pathname, 'https://dash.example.com/cli-auth');
      const callback = (query: string) =>
        HttpClient.get(`http://127.0.0.1:${url.searchParams.get('port')}/?${query}`);
      return {
        login,
        callback,
        url,
        state: encodeURIComponent(url.searchParams.get('state') ?? ''),
      };
    });

    it.effect(
      'takes the key the dashboard hands back with this run’s state, and nothing else',
      () =>
        Effect.gen(function* () {
          const { login, callback, state } = yield* startLogin;
          assert.strictEqual((yield* callback('state=other&key=key_stolen')).status, 403);
          assert.strictEqual((yield* callback(`state=${state}`)).status, 403);
          assert.strictEqual((yield* callback(`state=${state}&key=key_browser`)).status, 200);
          assert.strictEqual(Redacted.value(yield* Fiber.join(login)), 'key_browser');
        }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    it.effect('fails when the user cancels in the browser', () =>
      Effect.gen(function* () {
        const { login, callback, state } = yield* startLogin;
        assert.strictEqual((yield* callback(`state=${state}&error=denied`)).status, 200);
        const error = yield* Effect.flip(Fiber.join(login));
        assert.strictEqual(error.message, 'Authorization was cancelled in the browser.');
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    it.effect(
      'hands the consent page its params, and the callback to accept, which may refuse or fail it',
      () =>
        Effect.gen(function* () {
          const opened = yield* Deferred.make<string>();
          const login = yield* approveInBrowser({
            product: 'example.com',
            consentUrl: 'https://example.com/cli/approve',
            params: { publicKey: 'pk', name: 'laptop' },
            accept: ({ state, query }) => {
              if (query.sealed === undefined) return Effect.succeedNone;
              if (query.sealed !== `for-${state}`) return Effect.fail('unsealable' as const);
              return Effect.succeedSome(query.sealed);
            },
          }).pipe(Effect.provide(failingOpener(opened)), Effect.forkChild);
          const url = new URL(yield* Deferred.await(opened));
          assert.strictEqual(url.searchParams.get('publicKey'), 'pk');
          assert.strictEqual(url.searchParams.get('name'), 'laptop');
          const state = url.searchParams.get('state') ?? '';
          const callback = (query: Record<string, string>) =>
            HttpClient.get(
              `http://127.0.0.1:${url.searchParams.get('port')}/callback?${new URLSearchParams({ state, ...query })}`,
            );

          assert.strictEqual((yield* callback({})).status, 403);
          assert.strictEqual((yield* callback({ sealed: 'for-another' })).status, 400);
          assert.strictEqual(yield* Effect.flip(Fiber.join(login)), 'unsealable');
        }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    it.effect('says where to approve through `announce`, and prints nothing itself', () =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<string>();
        const announced = yield* Deferred.make<string>();
        const login = yield* approveInBrowser({
          product: 'example.com',
          consentUrl: 'https://example.com/cli/approve',
          announce: url => Deferred.succeed(announced, url).pipe(Effect.asVoid),
          accept: ({ query }) => Effect.succeed(Option.fromNullishOr(query.sealed)),
        }).pipe(Effect.provide(failingOpener(opened)), Effect.forkChild);
        const url = new URL(yield* Deferred.await(opened));
        // What was announced is the page the browser is opened on.
        assert.strictEqual(yield* Deferred.await(announced), url.toString());
        const state = url.searchParams.get('state') ?? '';
        yield* HttpClient.get(
          `http://127.0.0.1:${url.searchParams.get('port')}/?state=${state}&sealed=ok`,
        );
        assert.strictEqual(yield* Fiber.join(login), 'ok');
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    it.effect('refuses a request that is no URL, and keeps listening', () =>
      Effect.gen(function* () {
        const { login, callback, state, url } = yield* startLogin;
        const port = url.searchParams.get('port') ?? '';
        const answer = yield* Effect.promise(
          () => rawConnection(port, 'GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n').closed,
        );
        assert.match(answer, /^HTTP\/1\.1 400 /u);
        assert.strictEqual((yield* callback(`state=${state}&key=key_browser`)).status, 200);
        assert.strictEqual(Redacted.value(yield* Fiber.join(login)), 'key_browser');
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    it.effect('closes every connection still open once the login is done', () =>
      Effect.gen(function* () {
        const { login, callback, state, url } = yield* startLogin;
        const port = url.searchParams.get('port') ?? '';
        // A request the browser never finished, held open by the server.
        const { closed } = rawConnection(port, `GET /?state=${state} HTTP/1.1\r\nHost: x\r\n`);
        assert.strictEqual((yield* callback(`state=${state}&key=key_browser`)).status, 200);
        assert.strictEqual(Redacted.value(yield* Fiber.join(login)), 'key_browser');
        yield* Effect.promise(() => closed);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );

    /** A machine whose opener records the command and arguments it is asked to run. */
    const recordingOpener = (spawned: { command: string; args: readonly string[] }[]) =>
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(command => {
          if (ChildProcess.isStandardCommand(command)) {
            spawned.push({ command: command.command, args: command.args });
          }
          return Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'ChildProcess',
              method: 'spawn',
            }),
          );
        }),
      );

    it.effect('opens and announces nothing but an http(s) page, whoever names it', () =>
      Effect.gen(function* () {
        for (const consentUrl of [
          'file:///etc/passwd',
          'javascript:alert(1)',
          'ms-settings:',
          '/cli-auth',
          '--help',
        ]) {
          const spawned: { command: string; args: readonly string[] }[] = [];
          const announced: string[] = [];
          const error = yield* approveInBrowser({
            product: 'example.com',
            consentUrl,
            announce: url => Effect.sync(() => void announced.push(url)),
            accept: () => Effect.succeedNone,
          }).pipe(Effect.provide(recordingOpener(spawned)), Effect.flip);
          assert.strictEqual(error._tag, 'CliLoginError');
          assert.deepStrictEqual({ spawned, announced }, { spawned: [], announced: [] });
        }
      }),
    );

    it.effect('opens the page on Windows with no shell to read its `&`s', () =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<{ command: string; args: readonly string[] }>();
        const platform = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32' });
        const login = yield* approveInBrowser({
          product: 'example.com',
          consentUrl: 'https://example.com/cli/approve?from=cli',
          params: { name: 'a&calc' },
          accept: () => Effect.succeedNone,
        }).pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(command =>
                Deferred.succeed(opened, {
                  command: ChildProcess.isStandardCommand(command) ? command.command : '',
                  args: ChildProcess.isStandardCommand(command) ? command.args : [],
                }).pipe(
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
            ),
          ),
          Effect.forkChild,
        );
        const { command, args } = yield* Deferred.await(opened).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
            }),
          ),
        );
        yield* Fiber.interrupt(login);
        assert.strictEqual(command, 'rundll32');
        assert.strictEqual(args[0], 'url.dll,FileProtocolHandler');
        const url = new URL(args[1] ?? '');
        assert.strictEqual(url.searchParams.get('from'), 'cli');
        assert.strictEqual(url.searchParams.get('name'), 'a&calc');
      }),
    );

    // On its own clock: `layer(…)` shares one test clock across the block's tests.
    it.effect('gives up three minutes after opening the browser', () =>
      Effect.gen(function* () {
        const { login } = yield* startLogin;
        yield* TestClock.adjust('3 minutes');
        const error = yield* Effect.flip(Fiber.join(login));
        assert.strictEqual(error.message, 'Timed out waiting for authorization.');
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
