import { createServer, type Server, type ServerResponse } from 'node:http';
import * as Console from 'effect/Console';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as ChildProcess from 'effect/process/ChildProcess';
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Queue from 'effect/Queue';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import * as Stream from 'effect/Stream';

// Browser-based `<cli> login`, the loopback redirect flow every familiar CLI uses (gh / vercel /
// stripe): spin up a one-shot HTTP server on 127.0.0.1, open the dashboard's consent page pointed at
// that port, and let the approved page navigate the browser straight here with the key on the query
// string. A random `state` nonce ties the callback to this exact run so nothing else on the
// machine can complete it. What the callback carries is the caller's (`approveInBrowser`'s `accept`):
// a plain key (`loginViaBrowser`, whose limits are in DECISIONS.md), or a login sealed to the CLI's
// own key. It's a top-level navigation (not a fetch) on purpose: a public page that *fetches* a
// loopback address trips the browser's "access devices on your network" permission prompt, whereas
// navigating to it does not.
//
// ponytail: node:http, not NodeHttpServer — for this one request it would add ~100 kB (and `ws`) to
// the bundled CLI.

/** The login failed in a way the user can act on: cancelled in the browser, timed out, no port. */
export class CliLoginError extends Schema.TaggedError<CliLoginError>()('CliLoginError', {
  reason: Schema.Literals(['Denied', 'TimedOut', 'Unavailable']),
  message: Schema.String,
}) {}

// The page the browser lands on. It closes itself after a beat — allowed because the consent page
// navigated here with `location.replace`, leaving this as the tab's only history entry — and the
// visible copy is the fallback for browsers that refuse the programmatic close.
const page = (product: string, title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · ${product}</title>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0f10;color:#e7eceb;font-family:ui-sans-serif,system-ui,sans-serif">
<main style="max-width:22rem;padding:2rem;text-align:center">
<h1 style="font-size:1.125rem;font-weight:600;margin:0 0 .5rem">${title}</h1>
<p style="font-size:.875rem;line-height:1.6;color:#8b9794;margin:0">${body}</p>
</main>
<script>setTimeout(function(){try{window.close()}catch(e){}},250)</script>`;

const successHtml = (product: string) =>
  page(
    product,
    'You’re all set',
    `The ${product} CLI is authorized. You can close this tab and return to your terminal.`,
  );
const deniedHtml = (product: string) =>
  page(
    product,
    'Authorization cancelled',
    'No key was issued. You can close this tab and return to your terminal.',
  );
const failedHtml = (product: string) =>
  page(
    product,
    'Authorization failed',
    `The ${product} CLI couldn’t use this approval. Your terminal says why.`,
  );

/** Best-effort open in the default browser; a failure is silent because the URL is printed too. */
const openBrowser = Effect.fnUntraced(
  function* (url: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const [command, args] = ((): readonly [string, ReadonlyArray<string>] => {
      if (process.platform === 'darwin') return ['open', [url]];
      if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
      return ['xdg-open', [url]];
    })();
    const opener = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
    );
    // Unreferenced, the opener and the browser it starts outlive this scope (whose release would
    // otherwise end the opener's process group) and the CLI.
    // ponytail: Effect's spawner still kills the group if the opener exits non-zero, which could take
    // a browser `xdg-open` started down with it; the printed URL recovers. Spawn undetached if seen.
    yield* Effect.asVoid(opener.unref);
  },
  Effect.scoped,
  Effect.ignore(),
);

type Request = {
  readonly query: Readonly<Record<string, string>>;
  readonly response: ServerResponse;
};

// `Connection: close` on every response so the browser's socket drops right after the body flushes
// instead of sitting in keep-alive, which would hold the process open after the user is back in the
// terminal.
const writeRefusal = (response: ServerResponse, status: number) => {
  response.writeHead(status, { 'content-type': 'text/plain', Connection: 'close' });
  response.end('Invalid request');
};

/**
 * A loopback server on a free port, closed with the scope along with every connection still open,
 * and the requests it receives carrying `state`. Anything else (a /favicon.ico hit, a request line
 * that is no URL) is refused on the spot, so nothing waits behind the callback.
 */
const listen = (state: string) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<Request>();
    const server = yield* Effect.acquireRelease(
      Effect.callback<Server, CliLoginError>(resume => {
        const server = createServer((request, response) => {
          const url = URL.parse(request.url ?? '/', 'http://127.0.0.1');
          if (url === null) return writeRefusal(response, 400);
          const query = Object.fromEntries(url.searchParams);
          if (query.state !== state) return writeRefusal(response, 403);
          Queue.offerUnsafe(requests, { query, response });
        });
        server.once('error', ({ message }) =>
          resume(
            Effect.fail(
              new CliLoginError({
                reason: 'Unavailable',
                message: `Couldn’t start the login callback: ${message}`,
              }),
            ),
          ),
        );
        server.listen(0, '127.0.0.1', () => resume(Effect.succeed(server)));
      }),
      server =>
        Effect.sync(() => {
          server.close();
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!Predicate.isObject(address)) {
      return yield* Effect.die('The login callback server has no TCP port.');
    }
    return { port: address.port, requests };
  });

/** Answers, once the response has left (or its connection has gone), so closing the server can't cut it off. */
const respond = (response: ServerResponse, status: number, html: string) =>
  Effect.callback<void>(resume => {
    response.once('close', () => resume(Effect.void));
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', Connection: 'close' });
    response.end(html);
  });

const refuse = (response: ServerResponse) => Effect.sync(() => writeRefusal(response, 403));

/** This run's callback query: its parameters, `state` among them. */
export type Callback = { readonly state: string; readonly query: Readonly<Record<string, string>> };

/**
 * Run the loopback flow and resolve with what `accept` makes of this run's callback. The consent
 * page (`https://dash.example.com/cli-auth`) gets `?port=&state=` and then `params`; once the user
 * answers it navigates to `http://127.0.0.1:<port>/…?state=…&…`, or `&error=denied`, which wins
 * over anything else. A request without this run's `state`, or one `accept` answers `None` for (a
 * /favicon.ico hit, a callback missing its fields), is refused, and the server keeps listening.
 * Fails on denial, on `accept`'s error, or after three minutes. Progress goes to stderr, so stdout
 * stays clean.
 */
export const approveInBrowser = Effect.fn('login.approveInBrowser')(function* <A, E>({
  product,
  consentUrl,
  params = {},
  accept,
}: {
  /** The name the landing page shows: `example.com`. */
  readonly product: string;
  readonly consentUrl: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly accept: (callback: Callback) => Effect.Effect<Option.Option<A>, E>;
}) {
  const crypto = yield* Crypto.Crypto;
  const state = Base64Url.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
  const { port, requests } = yield* listen(state);
  const authUrl = `${consentUrl}?${new URLSearchParams({ port: String(port), state, ...params })}`;
  yield* Console.error(`Opening your browser to authorize:\n  ${authUrl}`);
  yield* Console.error('Waiting for you to approve… (Ctrl-C to cancel)');
  yield* openBrowser(authUrl);

  const answer = Effect.fnUntraced(function* ({ query, response }: Request) {
    if (query.error !== undefined) {
      yield* respond(response, 200, deniedHtml(product));
      return yield* new CliLoginError({
        reason: 'Denied',
        message: 'Authorization was cancelled in the browser.',
      });
    }
    const accepted = yield* accept({ state, query }).pipe(
      Effect.tapError(() => respond(response, 400, failedHtml(product))),
    );
    yield* Option.isSome(accepted)
      ? respond(response, 200, successHtml(product))
      : refuse(response);
    return accepted;
  });

  const accepted = yield* Stream.fromQueue(requests).pipe(
    Stream.mapEffect(answer),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.timeoutOrElse({
      duration: '3 minutes',
      orElse: () =>
        Effect.fail(
          new CliLoginError({
            reason: 'TimedOut',
            message: 'Timed out waiting for authorization.',
          }),
        ),
    }),
  );
  // The queue never ends while the server listens, so the stream ends only with a callback.
  return yield* Option.match(Option.flatten(accepted), {
    onNone: () => Effect.die('The login callback server stopped listening.'),
    onSome: Effect.succeed,
  });
}, Effect.scoped);

const KeyCallbackSchema = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String) });

/**
 * The API key the dashboard hands back: `consentUrl` gets `?port=&state=` and, once approved,
 * navigates to `http://127.0.0.1:<port>/?state=…&key=…` (or `&error=denied`).
 */
export const loginViaBrowser = ({
  product,
  consentUrl,
}: {
  readonly product: string;
  readonly consentUrl: string;
}): Effect.Effect<
  Redacted.Redacted<string>,
  CliLoginError,
  Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner
> =>
  approveInBrowser({
    product,
    consentUrl,
    accept: ({ query }) =>
      Effect.succeed(
        Option.map(Schema.decodeUnknownOption(KeyCallbackSchema)(query), ({ key }) => key),
      ),
  });
