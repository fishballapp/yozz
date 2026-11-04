import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  MAIL_FRAME_MEASURE_SCRIPT,
  SERVED_MAIL_DATA_ID,
  type ServedMail,
} from '@yozz.app/mail/threads/frame-scripts';
import SERVED_MAIL_SCRIPT from '@yozz.app/mail/threads/served-mail?iife';
import * as Crypto from 'effect/Crypto';
import * as Effect from 'effect/Effect';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Queue from 'effect/Queue';
import { HtmlServerError } from '../errors.ts';

// `yozz read --serve-html`: a loopback server holding each message's HTML as a page, so an agent can
// see a mail as it looks. The page sanitises the mail in the browser, as yozz.app does
// (`@yozz.app/mail/threads/served-mail`), because DOMPurify needs a browser's CSS parser. Why it is
// this shape: DECISIONS.md.
//
// ponytail: any program on this machine that gets a printed link can read that mail while the
// server is up. Accepted: such a program can read far more than one mail, and the links print only
// on the stdout of whoever ran the command.

/** A request to a real URL within this long keeps the server up. */
export const IDLE_LIMIT = '10 minutes';

const SECRET_BYTES = 32;

/** The reader's ground in yozz.app (`--ink-sunken`): a frame with no colours of its own sits on it. */
const GROUND = 'oklch(0.128 0.006 75)';

const sha256 = (script: string) =>
  `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

/** Everything the page may do, in the headers so no byte of the mail comes before it. */
export const pageHeaders = ({ allowRemoteImages }: { readonly allowRemoteImages: boolean }) => ({
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': [
    "default-src 'none'",
    `script-src ${sha256(SERVED_MAIL_SCRIPT)} ${sha256(MAIL_FRAME_MEASURE_SCRIPT)}`,
    "style-src 'unsafe-inline'",
    // The frame's own policy narrows this to the origins the mail's images name.
    `img-src data:${allowRemoteImages ? ' https:' : ''}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-DNS-Prefetch-Control': 'off',
  // As apps/web/public/_headers.
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
});

const DATA_BLOCK_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** The raw mail is the most dangerous text on the page: with no `<` it can't end its block. */
export const dataBlockTextOf = (mail: ServedMail) =>
  JSON.stringify(mail).replace(
    /[<>&\u2028\u2029]/g,
    character => DATA_BLOCK_ESCAPES[character] ?? '',
  );

/**
 * A frame with no colours of its own is transparent and dark, so the page starts dark; its script
 * turns the page white under a white mail.
 */
export const pageOf = (mail: ServedMail) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="dark"><title>YOZZ mail</title><link rel="icon" href="data:,"><style>:root{color-scheme:dark;background:${GROUND};color:oklch(0.945 0.008 85)}body{margin:0;font:14px/1.5 system-ui,sans-serif}iframe{display:block;width:100%;border:0}</style></head><body><script type="application/json" id="${SERVED_MAIL_DATA_ID}">${dataBlockTextOf(mail)}</script><script>${SERVED_MAIL_SCRIPT}</script></body></html>`;

const refuse = (response: ServerResponse) => {
  response.writeHead(404, { 'Content-Length': '0', Connection: 'close' });
  response.end();
};

/**
 * The server, on 127.0.0.1 and a free port, closed with the scope along with every connection. It
 * serves nothing until `add` gives it a page, and answers anything but a page's exact URL with a
 * bare 404, which does not count as a visit.
 */
export const openHtmlServer = Effect.fnUntraced(function* ({
  allowRemoteImages,
}: {
  readonly allowRemoteImages: boolean;
}) {
  const crypto = yield* Crypto.Crypto;
  const headers = pageHeaders({ allowRemoteImages });
  const pages = new Map<string, Buffer>();
  const visits = yield* Queue.unbounded<void>();
  const server = yield* Effect.acquireRelease(
    Effect.callback<Server, HtmlServerError>(resume => {
      const server = createServer({ requireHostHeader: false }, (request, response) => {
        const page = pages.get(request.url ?? '');
        // The exact Host stops DNS rebinding: a page on evil.example resolved to 127.0.0.1 sends its own.
        if (
          page === undefined ||
          request.method !== 'GET' ||
          request.headers.host !== `127.0.0.1:${request.socket.localPort}`
        ) {
          return refuse(response);
        }
        Queue.offerUnsafe(visits, undefined);
        response.writeHead(200, {
          ...headers,
          'Content-Length': String(page.length),
          Connection: 'close',
        });
        response.end(page);
      });
      // Bytes that are no HTTP request get what any other wrong request gets.
      server.on('clientError', (_error, socket) =>
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
      );
      server.once('error', ({ message }) =>
        resume(
          Effect.fail(new HtmlServerError({ message: `Can't serve the mail's HTML: ${message}` })),
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
    return yield* Effect.die('The HTML server has no TCP port.');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    /** A new page for this message's HTML, under its own URL, whose secret reaches nothing else. */
    add: Effect.fnUntraced(function* (html: string) {
      const secret = Base64Url.encode(yield* crypto.randomBytes(SECRET_BYTES).pipe(Effect.orDie));
      pages.set(`/${secret}`, Buffer.from(pageOf({ html, allowRemoteImages })));
      return `${origin}/${secret}`;
    }),
    /** Keeps only the pages at `urls`, then waits until none of them is asked for in `IDLE_LIMIT`. */
    serve: (urls: readonly string[]) =>
      Effect.gen(function* () {
        const kept = new Set(urls);
        for (const path of pages.keys()) {
          if (!kept.has(`${origin}${path}`)) pages.delete(path);
        }
        yield* Queue.take(visits).pipe(
          Effect.timeoutOption(IDLE_LIMIT),
          Effect.repeat({ while: Option.isSome }),
          Effect.asVoid,
        );
      }),
  };
});
