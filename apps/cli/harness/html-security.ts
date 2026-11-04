/**
 * `yozz read --serve-html` in real browsers: the built `dist/bin.js` against crafted mail, in Chromium,
 * Firefox and WebKit. Every verdict comes from what local listeners heard and what the page holds.
 * Starts everything it needs and stops it. No real mail goes anywhere.
 *
 * What stands in: the Worker is the CLI's fake one, holding a real vault, on an HTTP port. The mail
 * server is the CLI's in-memory IMAP server over TLS under a test CA, on the real port 993, which the
 * CLI insists on. A self-signed HTTPS listener plays the sender's image host, since
 * `https://127.0.0.1:<port>/…` passes the image policy, and a plain HTTP listener catches whatever
 * must never fire.
 *
 * `YOZZ_CAPTURES=<dir>` also saves the screenshots a pull request shows.
 *
 * Idle exit is in `src/mail/read.test.ts`, on a TestClock: ten real minutes is no gate.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  type BrowserContext,
  type BrowserType,
  chromium,
  type Frame,
  firefox,
  type Page,
  webkit,
} from '@playwright/test';
import { MAIL_FRAME_MEASURE_SCRIPT } from '@yozz.app/mail/threads/frame-scripts';
import * as Effect from 'effect/Effect';
import { parseAst } from 'rolldown/parseAst';
import { API, makeWorld } from '../src/fake-worker.ts';
import { type FakeMessage, makeFakeImapServer } from '../src/mail/fake-imap-server.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '../dist/bin.js');
const IMAP_PORT = 993;
const ADDRESS = 'jason@fishball.test';
const NETWORK_SETTLE_MS = 400;
const PAGE_TIMEOUT_MS = 10_000;

const captures = process.env.YOZZ_CAPTURES;

let checks = 0;
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`✗ ${message}`);
  checks += 1;
};
const settle = () => new Promise(done => setTimeout(done, NETWORK_SETTLE_MS));

// ---- Certificates ----

const makeCertificates = (dir: string) => {
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(
    join(dir, 'ca.ext'),
    'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',
  );
  writeFileSync(
    join(dir, 'leaf.ext'),
    [
      'basicConstraints=critical,CA:FALSE',
      'keyUsage=critical,digitalSignature',
      'extendedKeyUsage=serverAuth',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid',
      '',
    ].join('\n'),
  );
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  openssl('req', '-new', '-key', 'ca.key', '-subj', '/CN=YOZZ html gate CA', '-out', 'ca.csr');
  openssl(...'x509 -req -in ca.csr -signkey ca.key -days 2 -extfile ca.ext -out ca.pem'.split(' '));
  openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  openssl('req', '-new', '-key', 'leaf.key', '-subj', '/CN=localhost', '-out', 'leaf.csr');
  openssl(
    ...'x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile leaf.ext -out leaf.pem'.split(
      ' ',
    ),
  );
  return {
    caPem: join(dir, 'ca.pem'),
    key: readFileSync(join(dir, 'leaf.key')),
    cert: readFileSync(join(dir, 'leaf.pem')),
  };
};

// ---- The listeners ----

type Hit = { readonly url: string; readonly referer: string | undefined };
type Listener = { readonly hits: Hit[]; readonly origin: string; readonly server: Server };

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
  'base64',
);
const heroSvg = (hue: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hue}"/><stop offset="1" stop-color="#20313f"/></linearGradient></defs><rect width="600" height="240" fill="url(#g)"/><text x="40" y="132" font-family="Georgia,serif" font-size="34" fill="#fff">The autumn roast is in</text></svg>`;

const listen = async (server: Server, scheme: 'http' | 'https', hits: Hit[]): Promise<Listener> => {
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listener has no port');
  return { hits, server, origin: `${scheme}://127.0.0.1:${address.port}` };
};

/** Answers with an image, so a loaded picture is really a picture. */
const recordingListener =
  (hits: Hit[]) =>
  (incoming: import('node:http').IncomingMessage, outgoing: import('node:http').ServerResponse) => {
    // Every URL in the fixtures is 127.0.0.1; a dev tool on this machine may probe localhost's ports.
    if (incoming.headers.host?.startsWith('127.0.0.1:') === true) {
      hits.push({ url: incoming.url ?? '', referer: incoming.headers.referer });
    }
    const isPixel = incoming.url?.includes('pixel') === true;
    // A link's target is a page, so the tab it opens can be asked what it is.
    if (incoming.url?.startsWith('/link') === true) {
      outgoing.writeHead(200, { 'Content-Type': 'text/html', Connection: 'close' });
      outgoing.end('<!doctype html><title>the sender</title>');
      return;
    }
    outgoing.writeHead(200, {
      'Content-Type': isPixel ? 'image/gif' : 'image/svg+xml',
      'Access-Control-Allow-Origin': '*',
      Connection: 'close',
    });
    outgoing.end(isPixel ? TRANSPARENT_GIF : heroSvg('#b85c38'));
  };

// ---- The fixtures ----

const message = (n: number, overrides: Partial<FakeMessage>): FakeMessage => ({
  from: 'hello@harbourcoffee.example',
  fromName: 'Harbour Coffee',
  to: ADDRESS,
  subject: `Fixture ${n}`,
  messageId: `<fixture-${n}@harbourcoffee.example>`,
  date: `Thu, ${String(n).padStart(2, '0')} Oct 2026 08:00:00 +0000`,
  text: `Plain text of fixture ${n}.`,
  ...overrides,
});
const idOf = ({ messageId }: FakeMessage) => `mid/${messageId}`;

const fixturesFor = ({ tls, plain }: { readonly tls: string; readonly plain: string }) => {
  const white = message(1, {
    subject: 'The autumn roast is in',
    html: `<html><head><style>.wrap{max-width:600px;margin:0 auto;font-family:Georgia,serif;color:#1f2430}a{color:#b85c38}h1{font-size:26px;margin:18px 0 6px}</style></head>
<body><div class="wrap" id="white-mail">
<img id="hero" src="${tls}/hero.svg" width="600" height="240" alt="">
<h1>The autumn roast is in</h1>
<p>Our Sidamo lot landed on Tuesday: stone fruit, black tea, a long sweet finish. Two hundred bags, roasted to order.</p>
<p><a id="order" href="${plain}/order">Order a bag</a></p>
<img id="pixel" src="${tls}/pixel.gif" width="1" height="1" alt="">
</div></body></html>`,
  });
  const dark = message(2, {
    subject: 'Notes from Tuesday',
    html: `<p id="dark-mail"><b>Notes from Tuesday</b></p><p>No colours in this mail at all, so it sits on the reader's own ground: light text, nothing behind it.</p><img id="hero" src="${tls}/notes.svg" width="480" height="200" alt="">`,
  });
  const secondInThread = message(3, {
    subject: 'Re: The autumn roast is in',
    inReplyTo: white.messageId,
    references: [white.messageId],
    html: '<p id="second-mail">Only the second message.</p>',
  });
  const textOnly = message(4, {
    subject: 'Re: The autumn roast is in',
    inReplyTo: white.messageId,
    references: [white.messageId],
    text: 'Text only: this message has no HTML part.',
  });
  const links = message(5, {
    subject: 'Links',
    html: `<p><a id="plain-link" href="${plain}/link-plain">plain</a></p>
<p><a id="top-link" href="${plain}/link-top" target="_top">top</a></p>
<p><a id="parent-link" href="${plain}/link-parent" target="_parent">parent</a></p>
<p><a id="blank-link" href="${plain}/link-blank" target="_blank">blank</a></p>
<p><a id="self-link" href="${plain}/link-self" target="_self">self</a></p>
<img id="map-image" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" usemap="#m" width="200" height="60" alt="">
<map name="m"><area id="area-link" shape="rect" coords="0,0,200,60" href="${plain}/link-area" target="_top" alt="area"></map>
<p><a id="image-link" href="${plain}/link-image"><img id="linked-image" src="${tls}/linked.svg" width="300" height="60" alt=""></a></p>
<p><a class="refused" href="javascript:fetch('${plain}/refused-js')">javascript</a></p>
<p><a class="refused" href="vbscript:msgbox(1)">vbscript</a></p>
<p><a class="refused" href="data:text/html,<script>fetch('${plain}/refused-data')</script>">data</a></p>
<p><a class="refused" href="file:///etc/passwd">file</a></p>
<p><a class="refused" href="/refused-relative">relative</a></p>
<p><a class="refused" href="https://yozz.app/settings">yozz.app</a></p>
<p><a class="refused" href="https://api.yozz.app/api/v1/account">api.yozz.app</a></p>
<p><a class="refused" href="${plain.replace('http://', 'http://user:secret@')}/refused-credentials">credentials</a></p>`,
  });
  const hostile = message(6, {
    subject: 'Hostile',
    html: `</script><script>parent.postMessage({type:'breakout'},'*');window.top.pwned=1;fetch('${plain}/breakout-script')</script>
<!-- <script> --><img src=x onerror="fetch('${plain}/breakout-comment')">
<script>alert('script');fetch('${plain}/script');parent.document.title='pwned';parent.postMessage({type:'script'},'*')</script>
<script src="${plain}/script-src.js"></script>
<img id="onerror" src="x" onerror="alert('onerror');fetch('${plain}/onerror');parent.postMessage({type:'onerror'},'*')">
<a id="js-url" href="javascript:alert('js');fetch('${plain}/js-url')">javascript url</a>
<iframe srcdoc="<script>parent.postMessage({type:'nested'},'*');fetch('${plain}/nested')</script>"></iframe>
<iframe src="${plain}/iframe-src"></iframe>
<svg onload="alert('svg');fetch('${plain}/svg')"><script>fetch('${plain}/svg-script')</script><image href="${plain}/svg-image"/></svg>
<div id="css-url" style="background-image:url(${tls}/css-inline.gif)">inline css</div>
<style>@import url(${plain}/import.css);@import "${tls}/import2.css";#css-rule{background:url(${tls}/css-rule.gif)}body{background-image:url(${plain}/css-body.gif)}@font-face{font-family:x;src:url(${plain}/font.woff)}</style>
<div id="css-rule">css rule</div>
<meta http-equiv="refresh" content="0;url=${plain}/meta-refresh">
<base href="${plain}/base/">
<img id="relative" src="relative.gif">
<form id="auto" action="${plain}/form" method="post"><input name="a" value="1"><input type="submit"></form>
<img src="x" onerror="document.forms.auto&&document.forms.auto.submit()">
<video src="${plain}/video.mp4" autoplay></video><audio src="${plain}/audio.mp3" autoplay></audio>
<object data="${plain}/object"></object><embed src="${plain}/embed">
<link rel="stylesheet" href="${plain}/link.css">
<img src="${plain}/plain-image.gif" width="100" height="100">
<p id="survivor">Still only mail.</p>
<math><mtext><style><img src=x onerror="fetch('${plain}/mxss')"></style></mtext></math>
<noscript><p title="</noscript><img src=x onerror=fetch('${plain}/noscript')>"></noscript>`,
  });
  const tall = message(7, {
    subject: 'A long mail',
    html: '<div id="tall" style="height:30000px">The top of a long mail, past yozz.app\'s own cap.</div>',
  });
  const giant = message(8, {
    subject: 'A mail that claims the world',
    html: '<div style="height:10000000px">Too tall.</div>',
  });
  return { white, dark, secondInThread, textOnly, links, hostile, tall, giant };
};

// ---- The CLI ----

type Row = { readonly id: string; readonly htmlUrl?: string; readonly isDraft?: boolean };
type Answer = {
  readonly notice: string;
  readonly threads: readonly { readonly messages: readonly Row[] }[];
};
type Run = {
  readonly child: ChildProcess;
  readonly answer: Answer;
  readonly stdout: () => string;
  readonly stderr: () => string;
};

const running = new Set<ChildProcess>();

/** The real bin, until its stdout has printed one whole JSON document. It may go on running. */
const startRead = (args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    child.once('exit', () => running.delete(child));
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => fail(new Error(`no answer from yozz ${args.join(' ')}: ${err}`)),
      30_000,
    );
    child.stderr.on('data', chunk => {
      err += chunk;
    });
    child.stdout.on('data', chunk => {
      out += chunk;
      try {
        const answer = JSON.parse(out) as Answer;
        clearTimeout(timer);
        done({ child, answer, stdout: () => out, stderr: () => err });
      } catch {
        // More of the document is on its way.
      }
    });
    child.once('exit', code => {
      if (out === '') fail(new Error(`yozz ${args.join(' ')} exited ${code}: ${err}`));
    });
  });

const exitOf = (child: ChildProcess): Promise<number | null> =>
  child.exitCode !== null
    ? Promise.resolve(child.exitCode)
    : new Promise(done => child.once('exit', code => done(code)));

const stop = async (child: ChildProcess) => {
  child.kill('SIGTERM');
  return exitOf(child);
};

const rowsOf = (answer: Answer) => answer.threads.flatMap(({ messages }) => messages);
const urlOf = (answer: Answer, { messageId }: FakeMessage) => {
  const url = rowsOf(answer).find(({ id }) => id === `mid/${messageId}`)?.htmlUrl;
  assert(url !== undefined, `${messageId} has an htmlUrl`);
  return url;
};

// ---- One raw request, as no browser could send it ----

const raw = (
  url: string,
  { method = 'GET', host }: { readonly method?: string; readonly host?: string | null } = {},
) =>
  new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((done, fail) => {
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
        done({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
          headers: response.headers,
        }),
      );
    });
    outgoing.on('error', fail);
    outgoing.end();
  });

const isRefused = (host: string, port: number) =>
  new Promise<boolean>(done => {
    const socket = connectTcp({ host, port, timeout: 1_000 });
    // A VPN's address can drop the packet rather than refuse it; either way nothing answered.
    socket.once('timeout', () => {
      socket.destroy();
      done(true);
    });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
  });

// ---- The checks that need no browser ----

/** The page script is one string literal in the bundle: no DOMPurify code runs in Node. */
const checkBundle = () => {
  const source = readFileSync(BIN, 'utf8');
  const literals: string[] = [];
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const { type, value, name } = node as { type?: string; value?: unknown; name?: unknown };
    if (type === 'Literal' && typeof value === 'string') literals.push(value);
    if (typeof name === 'string') names.add(name);
    for (const child of Object.values(node)) walk(child);
  };
  walk(parseAst(source, { lang: 'js' }));
  const holding = literals.filter(text => text.includes('addHook'));
  assert(holding.length === 1, `one string in the bundle holds DOMPurify, not ${holding.length}`);
  assert(holding[0]?.includes('allow-scripts'), 'the string holding DOMPurify is the page script');
  for (const name of ['addHook', 'isSupported', 'createDOMPurify']) {
    assert(!names.has(name), `no code in the bundle names ${name}`);
  }
  console.log('✓ bundle: DOMPurify only inside the embedded page string');
};

const checkServer = async (
  { answer, child }: Run,
  {
    white,
    secondInThread,
    textOnly,
    tls,
  }: { white: FakeMessage; secondInThread: FakeMessage; textOnly: FakeMessage; tls: Listener },
) => {
  const url = urlOf(answer, white);
  const { origin, port, pathname } = new URL(url);
  const refused: readonly [string, Promise<{ status: number; body: string }>][] = [
    ['wrong Host', raw(url, { host: `evil.example:${port}` })],
    ['localhost Host', raw(url, { host: `localhost:${port}` })],
    ['Host without a port', raw(url, { host: '127.0.0.1' })],
    ['Host with another port', raw(url, { host: '127.0.0.1:1' })],
    ['no Host', raw(url, { host: null })],
    ['an unknown path', raw(`${origin}/nope`)],
    ['/', raw(`${origin}/`)],
    ['/favicon.ico', raw(`${origin}/favicon.ico`)],
    ['a guessed secret', raw(`${origin}/${'A'.repeat(43)}`)],
    ['a query string', raw(`${url}?a=1`)],
    ['a trailing slash', raw(`${url}/`)],
    ['POST', raw(url, { method: 'POST' })],
    ['HEAD', raw(url, { method: 'HEAD' })],
    ['PUT', raw(url, { method: 'PUT' })],
    ['DELETE', raw(url, { method: 'DELETE' })],
  ];
  for (const [label, answered] of refused) {
    const { status, body } = await answered;
    assert(
      status === 404 && body === '',
      `${label} gets a bare 404, not ${status} "${body.slice(0, 40)}"`,
    );
  }
  const page = await raw(url);
  assert(page.status === 200, `the real URL answers, not ${page.status}`);
  const expected = {
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'x-dns-prefetch-control': 'off',
  };
  for (const [header, value] of Object.entries(expected)) {
    assert(page.headers[header] === value, `${header}: ${value}`);
  }
  assert(page.headers['set-cookie'] === undefined, 'the page sets no cookie');
  const csp = String(page.headers['content-security-policy']);
  for (const directive of [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    'img-src data:;',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ]) {
    assert(csp.includes(directive), `the page's CSP says ${directive}`);
  }
  assert(/script-src 'sha256-[^']+' 'sha256-[^']+';/.test(csp), 'script-src names only two hashes');

  const secrets = rowsOf(answer).flatMap(({ htmlUrl }) => (htmlUrl === undefined ? [] : [htmlUrl]));
  assert(new Set(secrets).size === secrets.length, 'every message has its own URL');
  assert(pathname.length === 44, 'the secret is 256 bits in base64url');
  const second = rowsOf(answer).find(({ id }) => id === idOf(secondInThread));
  assert(second?.htmlUrl !== url, "another message's URL is another URL");
  const text = rowsOf(answer).find(({ id }) => id === idOf(textOnly));
  assert(text !== undefined && text.htmlUrl === undefined, 'a text-only message has no htmlUrl');
  assert(answer.notice.includes('htmlUrl'), 'the notice covers what an htmlUrl shows');

  assert(new URL(url).hostname === '127.0.0.1', 'the URL is on 127.0.0.1');
  const portNumber = Number(port);
  const lan = Object.values(networkInterfaces())
    .flatMap(addresses => addresses ?? [])
    .filter(({ internal }) => !internal);
  assert(await isRefused('::1', portNumber), 'nothing answers on ::1');
  for (const { address } of lan) {
    assert(await isRefused(address, portNumber), `nothing answers on ${address}`);
  }
  assert(tls.hits.length === 0, 'raw requests reached no image host');
  assert(child.exitCode === null, 'the command is still running after every refusal');
  console.log(
    `✓ server: every wrong request a bare 404; loopback only (${lan.length} LAN addresses tried)`,
  );
};

// ---- One engine ----

/** Frames report through this on the top page, and every message but the height is a finding. */
const OBSERVER = () => {
  const seen: unknown[] = [];
  Object.assign(globalThis, { __messages: seen });
  addEventListener('message', event => {
    seen.push(event.data);
  });
};

const settled = <T>(work: Promise<T>, ms: number): Promise<T | string> =>
  Promise.race([
    work.catch(error => String(error).split('\n', 1)[0] ?? 'failed'),
    new Promise<string>(done => setTimeout(() => done(`no answer in ${ms} ms`), ms)),
  ]);

/** What a load that never finished looks like from each side, before the run fails on it. */
const reportHang = async (page: Page, url: string) => {
  const startedAt = Date.now();
  const server = await settled(
    fetch(url).then(res => `${res.status} in ${Date.now() - startedAt} ms`),
    5_000,
  );
  const state = await settled(
    page.evaluate(() => ({
      readyState: document.readyState,
      iframes: document.querySelectorAll('iframe').length,
      unfinished: performance
        .getEntriesByType('resource')
        .filter(entry => (entry as PerformanceResourceTiming).responseEnd === 0)
        .map(({ name }) => name.slice(0, 80)),
    })),
    5_000,
  );
  console.log(
    [
      'HANG: the page load did not finish',
      `  page.url: ${page.url().slice(0, 40)}, frames: ${page.frames().length}`,
      `  server, asked directly: ${server}`,
      `  the page itself: ${JSON.stringify(state)}`,
    ].join('\n'),
  );
};

/**
 * Playwright sometimes never hears that Firefox's first load finished: it still says about:blank
 * while the browser holds the whole mail. The mail was served, so that one shape is worth a second
 * tab. Anything else, such as a server that stopped answering, is what this harness is here to catch.
 */
const isLoadUnheard = async (page: Page) =>
  page.url() === 'about:blank' &&
  (await settled(
    page.evaluate(
      () => document.readyState === 'complete' && document.querySelector('iframe') !== null,
    ),
    5_000,
  )) === true;

const openMail = async (
  context: BrowserContext,
  url: string,
  isRetry = false,
): Promise<{
  readonly page: Page;
  readonly frame: Frame;
  readonly dialogs: string[];
  readonly violations: string[];
}> => {
  const page = await context.newPage();
  const dialogs: string[] = [];
  const violations: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  page.on('console', line => {
    if (/content.security.policy/i.test(line.text())) violations.push(line.text());
  });
  await page.addInitScript(OBSERVER);
  const failure = await page.goto(url, { waitUntil: 'load' }).then(
    () => null,
    (error: unknown) => error,
  );
  if (failure !== null) {
    if (!isRetry && (await isLoadUnheard(page))) {
      console.log('  (Playwright never heard this load finish; opening it in a second tab)');
      await page.close();
      return openMail(context, url, true);
    }
    await reportHang(page, url);
    throw failure;
  }
  await page.waitForSelector('iframe', { state: 'attached', timeout: PAGE_TIMEOUT_MS });
  const frame = await childOf(page);
  await settle();
  return { page, frame, dialogs, violations };
};

const childOf = async (page: Page): Promise<Frame> => {
  const handle = await page.waitForSelector('iframe', { state: 'attached' });
  const child = await handle.contentFrame();
  if (child === null) throw new Error('the mail frame has no content');
  await child.waitForLoadState('load');
  return child;
};

const messagesOn = (page: Page) =>
  page.evaluate(() =>
    (globalThis as typeof globalThis & { __messages: { type?: string }[] }).__messages.filter(
      ({ type }) => type !== 'yozz:mail-height',
    ),
  );

const runEngine = async ({
  label,
  browserType,
  plainRun,
  remoteRun,
  fixtures,
  tls,
  plain,
  unlisted,
}: {
  label: string;
  browserType: BrowserType<Browser>;
  plainRun: Run;
  remoteRun: Run;
  fixtures: ReturnType<typeof fixturesFor>;
  tls: Listener;
  plain: Listener;
  /** An HTTPS host no mail names, up and answering, so a request to it would be heard. */
  unlisted: Listener;
}) => {
  const browser = await browserType.launch({ headless: true });
  const assertSilence = (what: string) => {
    assert(
      tls.hits.length === 0,
      `${label}: ${what}: the image host heard ${JSON.stringify(tls.hits)}`,
    );
    assert(
      plain.hits.length === 0,
      `${label}: ${what}: the catch-all heard ${JSON.stringify(plain.hits)}`,
    );
  };
  const reset = () => {
    tls.hits.length = 0;
    plain.hits.length = 0;
  };
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 900, height: 700 },
    });
    const opened: Page[] = [];
    context.on('page', page => opened.push(page));
    const { white, dark, secondInThread, links, hostile, tall, giant } = fixtures;
    const proved: string[] = [];

    // 1 and 2: remote images withheld, the pixel neither fired nor drawn, and the page what it says.
    reset();
    const whiteUrl = urlOf(plainRun.answer, white);
    const mail = await openMail(context, whiteUrl);
    const { page, frame } = mail;
    assertSilence('a mail with remote images, opened');
    assert(
      (await frame.locator('#white-mail').count()) === 1,
      `${label}: the mail is in the frame`,
    );
    const hero = frame.locator('#hero');
    const heroBox = await hero.boundingBox();
    assert(
      heroBox !== null && heroBox.width > 500 && heroBox.height > 150,
      `${label}: a withheld image keeps its box: ${JSON.stringify(heroBox)}`,
    );
    assert(
      (await hero.getAttribute('src'))?.startsWith('data:image/gif') === true,
      `${label}: a withheld image holds no URL`,
    );
    assert(
      (await hero.getAttribute('title')) === null,
      `${label}: a withheld image says nothing about loading`,
    );
    assert(
      (await hero.getAttribute('data-yozz-withheld')) === null,
      `${label}: a withheld image has no marker the click script reads`,
    );
    assert(
      (await hero.evaluate(node => getComputedStyle(node).cursor)) !== 'pointer',
      `${label}: a withheld image doesn't look clickable`,
    );
    const pixelBox = await frame.locator('#pixel').boundingBox();
    assert(
      pixelBox !== null && pixelBox.width <= 1 && pixelBox.height <= 1,
      `${label}: a tracking pixel isn't drawn: ${JSON.stringify(pixelBox)}`,
    );
    assert(
      (await frame.locator('#pixel').getAttribute('data-yozz-withheld-box')) === null,
      `${label}: a tracking pixel has no box`,
    );
    const frameScripts = await frame
      .locator('script')
      .evaluateAll(nodes => nodes.map(node => node.textContent));
    assert(
      frameScripts.length === 1 && frameScripts[0] === MAIL_FRAME_MEASURE_SCRIPT,
      `${label}: the frame's one script is the measuring one`,
    );
    assert((await page.title()) === 'YOZZ mail', `${label}: the title is fixed`);
    const sandbox = await page.locator('iframe').getAttribute('sandbox');
    assert(
      sandbox === 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
      `${label}: the sandbox is yozz.app's, not "${sandbox}"`,
    );
    assert(
      (await page.locator('iframe').getAttribute('referrerpolicy')) === 'no-referrer',
      `${label}: the frame is no-referrer`,
    );
    const ground = await page.evaluate(() => ({
      margin: getComputedStyle(document.body).margin,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      background: getComputedStyle(document.documentElement).backgroundColor,
      dataBlock: document.querySelector('script[type="application/json"]') === null,
    }));
    assert(ground.margin === '0px', `${label}: the page has no margin`);
    assert(ground.scheme === 'light', `${label}: a white mail's page is color-scheme light`);
    assert(ground.background === 'rgb(255, 255, 255)', `${label}: a white mail's page is white`);
    assert(ground.dataBlock, `${label}: the raw mail has left the DOM`);
    assert(
      (await frame.evaluate(() => getComputedStyle(document.body).backgroundColor)) ===
        'rgb(255, 255, 255)',
      `${label}: a mail that sets colours keeps its white ground`,
    );
    proved.push('images withheld with a box, pixel silent');

    // 5: a click on a withheld image does nothing.
    const before = await hero.getAttribute('src');
    await hero.click();
    await settle();
    assertSilence('a click on a withheld image');
    assert(
      (await hero.getAttribute('src')) === before,
      `${label}: a click left the image as it was`,
    );
    assert((await messagesOn(page)).length === 0, `${label}: a click posted nothing`);
    const stillOpen = opened.filter(page => !page.isClosed());
    assert(stillOpen.length === 1, `${label}: a click opened nothing`);
    proved.push('click on a withheld image inert');

    // The header policy holds alone: what the top page itself tries is refused by the browser.
    await page.evaluate(
      ([tlsOrigin, plainOrigin]) => {
        const image = new Image();
        image.src = `${tlsOrigin}/top-image.gif`;
        document.body.append(image);
        void fetch(`${plainOrigin}/top-fetch`).catch(() => {});
        const script = document.createElement('script');
        script.src = `${plainOrigin}/top-script.js`;
        document.body.append(script);
        // default-src 'none' with no frame-src: the srcdoc above mounted, a real URL does not.
        const nested = document.createElement('iframe');
        nested.src = `${plainOrigin}/top-frame`;
        document.body.append(nested);
      },
      [tls.origin, plain.origin],
    );
    await settle();
    assertSilence('the top page trying to reach out');
    await page.close();

    // The dark ground: no colours declared, transparent frame, no CSP complaint.
    const darkMail = await openMail(context, urlOf(plainRun.answer, dark));
    assert(
      (await darkMail.frame.evaluate(() => getComputedStyle(document.body).backgroundColor)) ===
        'rgba(0, 0, 0, 0)',
      `${label}: a mail with no colours has a transparent body`,
    );
    assert(
      (await darkMail.frame.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      )) === 'dark',
      `${label}: a mail with no colours matches the page's colour scheme`,
    );
    assert(
      (await darkMail.page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      )) === 'dark',
      `${label}: a mail with no colours is on a dark page`,
    );
    assert(
      darkMail.violations.length === 0,
      `${label}: a plain mail breaks no CSP rule: ${darkMail.violations.join(' | ')}`,
    );
    assertSilence('the dark mail');
    await darkMail.page.close();
    proved.push('white and dark grounds');

    // 7: one URL, one message.
    const second = await openMail(context, urlOf(plainRun.answer, secondInThread));
    assert(
      (await second.frame.locator('#second-mail').count()) === 1,
      `${label}: the second message shows`,
    );
    assert(
      (await second.frame.locator('#white-mail').count()) === 0,
      `${label}: the second message's URL shows nothing else`,
    );
    const secondHtml = await second.page.content();
    assert(
      !secondHtml.includes('white-mail') && !secondHtml.includes('autumn'),
      `${label}: no other mail is anywhere on the page`,
    );
    await second.page.close();
    proved.push('one URL, one message');

    // 3: a link opens its own tab, as in yozz.app, and the mail's page never moves.
    const linkMail = await openMail(context, urlOf(plainRun.answer, links));
    const linkUrl = linkMail.page.url();
    const assertPagePut = (what: string) => {
      assert(
        linkMail.page.url() === linkUrl,
        `${label}: ${what} moved the page to ${linkMail.page.url()}`,
      );
      assert(linkMail.frame.url() === 'about:srcdoc', `${label}: ${what} moved the frame`);
    };
    const assertOpens = async (what: string, click: () => Promise<void>, path: string) => {
      reset();
      const opening = context.waitForEvent('page', { timeout: PAGE_TIMEOUT_MS });
      await click();
      const tab = await opening;
      await tab.waitForLoadState('load');
      assert(tab.url() === `${plain.origin}${path}`, `${label}: ${what} opened ${tab.url()}`);
      // A browser's own favicon request is not the link.
      const hits = plain.hits.filter(({ url }) => url !== '/favicon.ico');
      assert(
        hits.length === 1 && hits[0]?.url === path,
        `${label}: ${what} reached ${JSON.stringify(hits)}`,
      );
      assert(
        plain.hits.every(({ referer }) => referer === undefined),
        `${label}: ${what} sent a Referer: ${JSON.stringify(plain.hits)}`,
      );
      const seen = await tab.evaluate(() => ({
        opener: window.opener,
        referrer: document.referrer,
        origin: self.origin,
      }));
      assert(seen.opener === null, `${label}: ${what}'s tab has an opener`);
      assert(seen.referrer === '', `${label}: ${what}'s tab knows where it came from`);
      assert(seen.origin === plain.origin, `${label}: ${what}'s tab is still sandboxed`);
      assertPagePut(what);
      await tab.close();
    };
    for (const id of ['plain', 'top', 'parent', 'blank', 'self']) {
      // Each of these alone would hide the others going: a browser implies noopener on _blank, and
      // the frame is no-referrer.
      const link = linkMail.frame.locator(`#${id}-link`);
      assert((await link.getAttribute('target')) === '_blank', `${label}: #${id}-link is _blank`);
      assert(
        (await link.getAttribute('rel')) === 'noopener noreferrer',
        `${label}: #${id}-link is noopener noreferrer`,
      );
      await assertOpens(
        `#${id}-link`,
        () => linkMail.frame.locator(`#${id}-link`).click(),
        `/link-${id}`,
      );
    }
    await assertOpens(
      'an area',
      () => linkMail.frame.locator('#map-image').click({ position: { x: 20, y: 20 } }),
      '/link-area',
    );
    // A withheld picture in a link opens the link, as any linked picture does, and stays withheld.
    await assertOpens(
      'a withheld image in a link',
      () => linkMail.frame.locator('#linked-image').click(),
      '/link-image',
    );
    assert(tls.hits.length === 0, `${label}: a click on a linked image loaded it`);
    assert(
      (await linkMail.frame.locator('#linked-image').getAttribute('src'))?.startsWith(
        'data:image/gif',
      ) === true,
      `${label}: a linked image stays withheld after its link opened`,
    );

    // Unsafe schemes, a YOZZ origin, credentials and relative URLs are no links at all.
    reset();
    const refused = linkMail.frame.locator('a.refused');
    const refusedCount = await refused.count();
    assert(
      refusedCount === 8,
      `${label}: all 8 refused links are in the mail, not ${refusedCount}`,
    );
    const pagesBefore = opened.length;
    for (const index of Array.from({ length: refusedCount }, (_, index) => index)) {
      const link = refused.nth(index);
      const name = await link.textContent();
      assert((await link.getAttribute('href')) === null, `${label}: ${name} kept its href`);
      await link.click();
      await settle();
      assert(opened.length === pagesBefore, `${label}: ${name} opened a page`);
      assertPagePut(name ?? 'a refused link');
      assertSilence(`a click on the ${name} link`);
    }
    assert(
      (await linkMail.frame.locator('#self-link').count()) === 1,
      `${label}: the frame still holds the mail`,
    );
    await linkMail.page.close();
    proved.push('links open their own tab with no Referer, unsafe and YOZZ links refused');

    // 4: a hostile mail is only mail.
    reset();
    const bad = await openMail(context, urlOf(plainRun.answer, hostile));
    assertSilence('the hostile mail');
    assert(bad.dialogs.length === 0, `${label}: the hostile mail raised a dialog`);
    assert(
      (await messagesOn(bad.page)).length === 0,
      `${label}: the hostile mail posted ${JSON.stringify(await messagesOn(bad.page))}`,
    );
    const top = await bad.page.evaluate(() => ({
      title: document.title,
      isPwned: 'pwned' in globalThis,
      children: Array.from(document.body.children, node => node.tagName),
    }));
    assert(top.title === 'YOZZ mail', `${label}: the hostile mail changed the title`);
    assert(!top.isPwned, `${label}: the hostile mail wrote to the top window`);
    assert(
      top.children.join() === 'SCRIPT,IFRAME',
      `${label}: the top document is only the page script and the frame, not ${top.children.join()}`,
    );
    assert(
      (await bad.frame.locator('#survivor').count()) === 1,
      `${label}: the mail's text survives`,
    );
    for (const selector of [
      'iframe',
      'svg',
      'form',
      'input',
      'object',
      'embed',
      'video',
      'audio',
      'body meta',
      'base',
      'link',
      '[onerror]',
      '[onload]',
    ]) {
      assert(
        (await bad.frame.locator(selector).count()) === 0,
        `${label}: ${selector} survived sanitising`,
      );
    }
    assert(
      (await bad.frame.locator('script').count()) === 1,
      `${label}: only the measuring script is in the frame`,
    );
    assert(
      (await bad.frame.locator('#js-url').getAttribute('href')) === null,
      `${label}: the javascript: URL is gone`,
    );
    // Each layer alone: a script written straight into the frame still can't run or fetch.
    await bad.frame.evaluate(
      ([tlsOrigin, plainOrigin]) => {
        const script = document.createElement('script');
        script.src = `${plainOrigin}/direct-script.js`;
        document.body.append(script);
        const inline = document.createElement('script');
        inline.textContent = `parent.postMessage({type:'direct-inline'},'*')`;
        document.body.append(inline);
        const image = new Image();
        image.src = `${tlsOrigin}/direct-image.gif`;
        document.body.append(image);
        void fetch(`${plainOrigin}/direct-fetch`).catch(() => {});
      },
      [tls.origin, plain.origin],
    );
    await settle();
    assertSilence('a script written straight into the frame');
    assert(
      (await messagesOn(bad.page)).length === 0,
      `${label}: an unhashed inline script ran in the frame`,
    );
    await bad.page.close();
    proved.push('hostile mail contained');

    // The height: past yozz.app's cap for a long mail, clamped for an absurd one.
    const long = await openMail(context, urlOf(plainRun.answer, tall));
    await long.page.waitForFunction(
      () => Number.parseInt(document.querySelector('iframe')?.style.height ?? '0', 10) >= 30_000,
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
    assert(
      (await long.page.evaluate(() => document.documentElement.scrollHeight)) >= 30_000,
      `${label}: the page is as tall as the mail`,
    );
    await long.page.close();
    const absurd = await openMail(context, urlOf(plainRun.answer, giant));
    await absurd.page.waitForFunction(
      () => document.querySelector('iframe')?.style.height === '200000px',
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
    await absurd.page.close();
    proved.push('height measured under both CSPs, clamped at 200000');

    // 6: --remote-images loads them, and tells them nothing about the page.
    reset();
    const remoteUrl = urlOf(remoteRun.answer, white);
    const loaded = await openMail(context, remoteUrl);
    const secret = new URL(remoteUrl).pathname.slice(1);
    await loaded.frame.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('#hero');
      return image?.complete === true && image.naturalWidth === 600;
    });
    assert(
      tls.hits.some(({ url }) => url === '/hero.svg'),
      `${label}: --remote-images loads the picture`,
    );
    assert(
      tls.hits.some(({ url }) => url === '/pixel.gif'),
      `${label}: --remote-images loads the pixel too`,
    );
    assert(
      tls.hits.every(({ referer }) => referer === undefined),
      `${label}: an image request carried a Referer: ${JSON.stringify(tls.hits)}`,
    );
    assert(
      tls.hits.every(({ url }) => !url.includes(secret)),
      `${label}: an image request carried the secret`,
    );
    assert(
      (await loaded.frame.locator('#hero').getAttribute('data-yozz-withheld-box')) === null,
      `${label}: a loaded picture is no withheld box`,
    );
    assert(plain.hits.length === 0, `${label}: plain http stays out even with --remote-images`);
    // Only images: the policy's https: is for img-src alone, and only origins this mail names.
    await context.request.get(`${unlisted.origin}/control`);
    assert(unlisted.hits.length === 1, `${label}: the unlisted host hears`);
    unlisted.hits.length = 0;
    reset();
    await loaded.frame.evaluate(
      ([unlistedOrigin, listedOrigin, plainOrigin]) => {
        const image = new Image();
        image.src = `${unlistedOrigin}/unlisted.gif`;
        document.body.append(image);
        void fetch(`${listedOrigin}/remote-fetch`).catch(() => {});
        void fetch(`${plainOrigin}/remote-fetch`).catch(() => {});
      },
      [unlisted.origin, tls.origin, plain.origin],
    );
    await settle();
    assert(
      unlisted.hits.length === 0,
      `${label}: --remote-images loaded an origin the mail doesn't name`,
    );
    assert(tls.hits.length === 0, `${label}: --remote-images let the frame fetch`);
    assert(plain.hits.length === 0, `${label}: --remote-images opened nothing but images`);
    await loaded.page.close();
    proved.push('--remote-images loads, no Referer, no secret');

    console.log(`✓ ${label}: ${proved.join(' · ')}`);
    await context.close();
  } finally {
    await browser.close();
  }
};

// ---- The captures for a pull request ----

const capture = async (
  plainRun: Run,
  remoteRun: Run,
  { white, dark }: ReturnType<typeof fixturesFor>,
) => {
  if (captures === undefined) return;
  mkdirSync(captures, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 760, height: 560 },
    });
    for (const [name, url] of [
      ['served-white-withheld', urlOf(plainRun.answer, white)],
      ['served-dark-withheld', urlOf(plainRun.answer, dark)],
      ['served-white-remote-images', urlOf(remoteRun.answer, white)],
      ['served-dark-remote-images', urlOf(remoteRun.answer, dark)],
    ] as const) {
      const { page } = await openMail(context, url);
      await page.screenshot({ path: join(captures, `${name}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
};

// ---- The run ----

const root = mkdtempSync(join(tmpdir(), 'yozz-html-gate-'));
const servers: Server[] = [];
try {
  checkBundle();
  const certificates = makeCertificates(root);

  const tlsHits: Hit[] = [];
  const tlsServer = createHttpsServer(
    { key: certificates.key, cert: certificates.cert },
    recordingListener(tlsHits),
  );
  const tls = await listen(tlsServer, 'https', tlsHits);
  const unlistedHits: Hit[] = [];
  const unlistedServer = createHttpsServer(
    { key: certificates.key, cert: certificates.cert },
    recordingListener(unlistedHits),
  );
  const unlisted = await listen(unlistedServer, 'https', unlistedHits);
  const plainHits: Hit[] = [];
  const plain = await listen(createHttpServer(recordingListener(plainHits)), 'http', plainHits);
  servers.push(tlsServer, unlistedServer, plain.server);
  // A listener that can't hear would prove every silence: make sure each one does.
  assert((await raw(`${plain.origin}/control`)).status === 200, 'the catch-all answers');
  assert(plain.hits.length === 1, 'the catch-all hears');
  plain.hits.length = 0;

  const fixtures = fixturesFor({ tls: tls.origin, plain: plain.origin });

  const imap = makeFakeImapServer({ username: ADDRESS, password: 'secret' });
  for (const fixture of Object.values(fixtures)) imap.deliver('INBOX', fixture);
  const imapServer = createTlsServer(
    { key: certificates.key, cert: certificates.cert, minVersion: 'TLSv1.3' },
    socket => {
      const { duplex, destroy } = imap.open();
      socket.on('data', chunk => void duplex.write(new Uint8Array(chunk)));
      socket.on('close', () => destroy());
      socket.on('error', () => socket.destroy());
      void (async () => {
        for (;;) {
          const chunk = await duplex.read();
          if (chunk === null) {
            socket.end();
            return;
          }
          socket.write(chunk);
        }
      })();
    },
  );
  await new Promise<void>((done, fail) => {
    imapServer.once('error', error => fail(new Error(`port ${IMAP_PORT}: ${error.message}`)));
    // Any address, as macOS lets nobody but root bind a low port on one in particular.
    imapServer.listen(IMAP_PORT, done);
  });
  servers.push(imapServer as unknown as Server);

  const world = await Effect.runPromise(Effect.scoped(makeWorld()));
  await Effect.runPromise(
    world.putAddress(
      {
        address: ADDRESS,
        smtp: { host: 'localhost', port: 465, username: ADDRESS, password: 'secret' },
        imap: { host: 'localhost', port: IMAP_PORT, username: ADDRESS, password: 'secret' },
      },
      1,
    ),
  );
  const apiServer = createHttpServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const answer = await world.fetch(`${API}${incoming.url ?? '/'}`, {
      method: incoming.method ?? 'GET',
      headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, String(value)] as [string, string]],
      ),
      ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
    });
    outgoing.writeHead(answer.status, Object.fromEntries(answer.headers));
    outgoing.end(Buffer.from(await answer.arrayBuffer()));
  });
  const api = await listen(apiServer, 'http', []);
  servers.push(apiServer);

  let homes = 0;
  const cliEnv = (): NodeJS.ProcessEnv => {
    homes += 1;
    return {
      PATH: process.env.PATH,
      YOZZ_API_URL: api.origin,
      YOZZ_CLI_KEY: JSON.stringify({ ...world.credentials, apiUrl: api.origin }),
      XDG_CONFIG_HOME: join(root, `${homes}`, 'config'),
      XDG_STATE_HOME: join(root, `${homes}`, 'state'),
      XDG_CACHE_HOME: join(root, `${homes}`, 'cache'),
      NODE_EXTRA_CA_CERTS: certificates.caPem,
    };
  };

  // The main run: everything at once, with no connection left behind it. Only then any page.
  const ids = [
    fixtures.white,
    fixtures.dark,
    fixtures.links,
    fixtures.hostile,
    fixtures.tall,
    fixtures.giant,
  ].map(idOf);
  const commandsBefore = imap.commands.length;
  const plainRun = await startRead(['read', ...ids, '--serve-html'], cliEnv());
  assert(plainRun.child.exitCode === null, 'the JSON flushed while the command runs');
  assert(tls.hits.length === 0, 'no image was fetched to read');
  const commands = imap.commands.slice(commandsBefore);
  assert(
    commands.includes('LOGOUT'),
    `the server saw the logout before any page: ${commands.slice(-3).join(' | ')}`,
  );
  for (let tries = 0; tries < 20; tries += 1) {
    const open = await new Promise<number>(done =>
      imapServer.getConnections((_error, count) => done(count)),
    );
    if (open === 0) break;
    await new Promise(done => setTimeout(done, 50));
  }
  const openConnections = await new Promise<number>(done =>
    imapServer.getConnections((_error, count) => done(count)),
  );
  assert(openConnections === 0, `IMAP is closed while serving, not ${openConnections} open`);
  const bodyFetches = commands.filter(command => /\bBODY\b|BODY[.[]/.test(command));
  assert(bodyFetches.length > 0, 'bodies were fetched');
  assert(
    bodyFetches.every(command => command.includes('BODY.PEEK[')),
    `only BODY.PEEK: ${bodyFetches.join(' | ')}`,
  );
  assert(!commands.some(command => /STORE/i.test(command)), 'nothing stored a flag');
  assert(
    [...(imap.folders.get('INBOX')?.messages ?? [])].every(({ flags }) => flags.size === 0),
    'the mail is still unread on the server',
  );
  console.log(
    '✓ read: JSON flushed at once, IMAP logged out and closed first, only BODY.PEEK, no flag',
  );

  await checkServer(plainRun, {
    white: fixtures.white,
    secondInThread: fixtures.secondInThread,
    textOnly: fixtures.textOnly,
    tls,
  });

  const remoteRun = await startRead(['read', ...ids, '--serve-html', '--remote-images'], cliEnv());
  const remoteCsp = String(
    (await raw(urlOf(remoteRun.answer, fixtures.white))).headers['content-security-policy'],
  );
  assert(
    remoteCsp.includes('img-src data: https:;'),
    `--remote-images opens https: to images: ${remoteCsp}`,
  );

  // Exits at once: nothing printed has a URL, a draft's included.
  const quietEnv = cliEnv();
  const textRun = await startRead(
    ['read', idOf(fixtures.textOnly).replace('4', '4'), '--serve-html'],
    quietEnv,
  );
  const quietIds = rowsOf(textRun.answer).filter(({ id }) => id === idOf(fixtures.textOnly));
  assert(quietIds.length === 1, 'the text-only message is in its conversation');
  const textOnlyMail = message(9, { subject: 'Only text', text: 'Nothing but text.' });
  imap.deliver('INBOX', textOnlyMail);
  await stop(textRun.child);
  const onlyText = await startRead(
    ['read', idOf(textOnlyMail), '--serve-html', '--sync'],
    cliEnv(),
  );
  assert((await exitOf(onlyText.child)) === 0, 'a conversation with no HTML exits 0 at once');
  assert(
    rowsOf(onlyText.answer).every(({ htmlUrl }) => htmlUrl === undefined),
    'and prints no htmlUrl',
  );
  const draftEnv = cliEnv();
  const drafted = await startRead(
    [
      'draft',
      '--from',
      ADDRESS,
      '--to',
      'kate@example.com',
      '--subject',
      'Hi',
      '--text',
      '<b>Hello</b>',
    ],
    draftEnv,
  );
  await exitOf(drafted.child);
  const { draftId } = (drafted.answer as unknown as { draft: { draftId: string } }).draft;
  const draftRead = await startRead(['read', draftId, '--serve-html'], draftEnv);
  assert((await exitOf(draftRead.child)) === 0, 'a draft exits 0 at once');
  const [draftRow] = rowsOf(draftRead.answer);
  assert(draftRow?.isDraft === true && draftRow.htmlUrl === undefined, 'a draft has no htmlUrl');
  console.log('✓ no htmlUrl: text-only and draft print and exit at once');

  for (const [label, browserType] of [
    ['Chromium', chromium],
    ['Firefox', firefox],
    ['WebKit', webkit],
  ] as const) {
    await runEngine({ label, browserType, plainRun, remoteRun, fixtures, tls, plain, unlisted });
  }

  await capture(plainRun, remoteRun, fixtures);

  // SIGTERM ends it cleanly: the port goes, and it printed nothing past its one document.
  const { port } = new URL(urlOf(plainRun.answer, fixtures.white));
  const printed = plainRun.stdout();
  const code = await stop(plainRun.child);
  assert(code === 130, `SIGTERM exits as an interrupt does, not ${code}`);
  assert(plainRun.stdout() === printed, 'SIGTERM printed nothing further');
  assert(plainRun.stderr() === '', `SIGTERM printed nothing on stderr: ${plainRun.stderr()}`);
  assert(await isRefused('127.0.0.1', Number(port)), 'the port is closed');
  await stop(remoteRun.child);
  console.log('✓ SIGTERM: ends cleanly, port closed, nothing further printed');

  console.log(`\nAll ${checks} checks passed.`);
} finally {
  for (const child of running) child.kill('SIGKILL');
  for (const server of servers) server.close();
  for (const server of servers) (server as Server).closeAllConnections?.();
  rmSync(root, { recursive: true, force: true });
}
