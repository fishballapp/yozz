import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, layer } from '@effect/vitest';
import { MAIL_FRAME_MEASURE_SCRIPT } from '@yozz.app/mail/threads/frame-scripts';
import SERVED_MAIL_SCRIPT from '@yozz.app/mail/threads/served-mail?iife';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import { dataBlockTextOf, openHtmlServer, pageOf } from './html-server.ts';

type Answer = {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
};

/** A request as a browser couldn't send it: any method, any `Host`, or none. */
const send = (
  url: string,
  { method = 'GET', host }: { method?: string; host?: string | null } = {},
) =>
  Effect.promise(
    () =>
      new Promise<Answer>((resolve, reject) => {
        const { hostname, port, pathname, search } = new URL(url);
        const outgoing = request({
          hostname,
          port,
          path: `${pathname}${search}`,
          method,
          setHost: false,
          ...(host === null ? {} : { headers: { Host: host ?? `${hostname}:${port}` } }),
        });
        outgoing.on('response', response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
              headers: response.headers,
            }),
          );
        });
        outgoing.on('error', reject);
        outgoing.end();
      }),
  );

const opened = (allowRemoteImages = false) =>
  Effect.gen(function* () {
    const server = yield* openHtmlServer({ allowRemoteImages });
    const url = yield* server.add('<p>mail-one</p>');
    return { server, url };
  });

const hashOf = (script: string) =>
  `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

layer(NodeServices.layer)(it => {
  describe('the HTML server', () => {
    it.effect('gives each page its own long secret, on 127.0.0.1 alone', () =>
      Effect.gen(function* () {
        const { server, url } = yield* opened();
        const other = yield* server.add('<p>mail-two</p>');
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{43}$/);
        expect(other).not.toBe(url);
        const first = yield* send(url);
        const second = yield* send(other);
        expect(first.body).toContain('mail-one');
        expect(first.body).not.toContain('mail-two');
        expect(second.body).toContain('mail-two');
        expect(second.body).not.toContain('mail-one');
      }).pipe(Effect.scoped),
    );

    it.effect('puts the whole policy in the headers of the page', () =>
      Effect.gen(function* () {
        const { url } = yield* opened();
        const { status, headers } = yield* send(url);
        expect(status).toBe(200);
        expect(headers).toMatchObject({
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src ${hashOf(SERVED_MAIL_SCRIPT)} ${hashOf(MAIL_FRAME_MEASURE_SCRIPT)}; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-resource-policy': 'same-origin',
          'x-dns-prefetch-control': 'off',
          'permissions-policy':
            'accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
        });
        expect(headers['set-cookie']).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect('allows https images only when told to', () =>
      Effect.gen(function* () {
        const { url } = yield* opened(true);
        const { headers } = yield* send(url);
        expect(headers['content-security-policy']).toContain('; img-src data: https:;');
      }).pipe(Effect.scoped),
    );

    it.effect('answers anything but an exact GET with a bare 404', () =>
      Effect.gen(function* () {
        const { url } = yield* opened();
        const { origin, host } = new URL(url);
        const secret = new URL(url).pathname.slice(1);
        const refused = [
          ...['/', '/favicon.ico', `/${secret}/`, `/${secret}?a=1`, `//${secret}`, '/nope'].map(
            path => send(`${origin}${path}`),
          ),
          ...['POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].map(method => send(url, { method })),
          ...[
            `localhost:${new URL(url).port}`,
            '127.0.0.1',
            '127.0.0.1:1',
            'evil.example',
            `evil.example:${new URL(url).port}`,
            `${host}.evil.example`,
            null,
          ].map(wrong => send(url, { host: wrong })),
        ];
        for (const answer of yield* Effect.all(refused, { concurrency: 1 })) {
          expect(answer.status).toBe(404);
          expect(answer.body).toBe('');
          expect(answer.headers['content-security-policy']).toBeUndefined();
        }
      }).pipe(Effect.scoped),
    );

    it.effect('answers bytes that are no request the same way', () =>
      Effect.gen(function* () {
        const { url } = yield* opened();
        const answer = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const socket = connect(Number(new URL(url).port), '127.0.0.1', () =>
                socket.write('not http\r\n\r\n'),
              );
              const chunks: Buffer[] = [];
              socket.on('data', chunk => chunks.push(chunk));
              socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
              socket.on('error', reject);
            }),
        );
        expect(answer.startsWith('HTTP/1.1 404 Not Found\r\n')).toBe(true);
        expect(answer.endsWith('\r\n\r\n')).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect('forgets the pages nothing printed', () =>
      Effect.gen(function* () {
        const { server, url } = yield* opened();
        const cut = yield* server.add('<p>cut for the budget</p>');
        const serving = yield* server.serve([url]).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect((yield* send(url)).status).toBe(200);
        expect((yield* send(cut)).status).toBe(404);
        yield* Fiber.interrupt(serving);
      }).pipe(Effect.scoped),
    );

    it.effect('refuses every connection once its scope ends', () =>
      Effect.gen(function* () {
        const url = yield* opened().pipe(
          Effect.map(({ url }) => url),
          Effect.scoped,
        );
        const failed = yield* Effect.promise(
          () =>
            new Promise<boolean>(resolve => {
              const socket = connect(Number(new URL(url).port), '127.0.0.1', () => {
                socket.destroy();
                resolve(false);
              });
              socket.on('error', () => resolve(true));
            }),
        );
        expect(failed).toBe(true);
      }),
    );
  });

  describe('the page', () => {
    const HOSTILE =
      '</script><script>alert(1)</script><!-- <script> & \u2028\u2029 <img src=x onerror=alert(2)>';

    it.effect('escapes the data block so the mail cannot leave it', () =>
      Effect.sync(() => {
        const text = dataBlockTextOf({ html: HOSTILE, allowRemoteImages: false });
        expect(text).toBe(
          '{"html":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\\u003c!-- \\u003cscript\\u003e \\u0026 \\u2028\\u2029 \\u003cimg src=x onerror=alert(2)\\u003e","allowRemoteImages":false}',
        );
        expect(text).not.toMatch(/[<>&\u2028\u2029]/);
        expect(JSON.parse(text)).toEqual({ html: HOSTILE, allowRemoteImages: false });
      }),
    );

    it.effect('holds exactly its own two scripts, with a fixed title', () =>
      Effect.sync(() => {
        const page = pageOf({
          html: `<title>Sender's</title>${HOSTILE}`,
          allowRemoteImages: false,
        });
        const opening = [...page.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag);
        expect(opening).toEqual(['<script type="application/json" id="mail">', '<script>']);
        expect(page.match(/<\/script>/g)).toHaveLength(2);
        expect(page).toContain('<title>YOZZ mail</title>');
        expect(page).not.toContain('alert(2)>');
        expect(page).toContain(`<script>${SERVED_MAIL_SCRIPT}</script>`);
      }),
    );

    it.effect('embeds a script an HTML parser reads whole', () =>
      Effect.sync(() => {
        expect(SERVED_MAIL_SCRIPT).not.toMatch(/<\/script|<!--|<script/i);
        // The frame's script survives the bundle, so the hash the server sends is one it runs.
        expect(SERVED_MAIL_SCRIPT).toContain(
          'allow-scripts allow-popups allow-popups-to-escape-sandbox',
        );
        expect(SERVED_MAIL_SCRIPT).not.toContain('allow-top-navigation');
        expect(SERVED_MAIL_SCRIPT).not.toContain('allow-same-origin');
      }),
    );
  });
});
