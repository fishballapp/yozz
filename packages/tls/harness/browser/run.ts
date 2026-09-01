/**
 * One full handshake per engine against real mail servers. Network, so by hand only.
 *
 *     pnpm -F @yozz.app/tls browser                       # local bridge, all three engines
 *     pnpm -F @yozz.app/tls browser --engine webkit       # one engine
 *     pnpm -F @yozz.app/tls browser --bridge "wss://…?key=…"   # through a deployed Worker
 *     pnpm -F @yozz.app/tls browser --relay ws://localhost:8177/api/v1/relay --cookie <token>
 *
 * Through the production relay (`apps/worker-api`, `/api/v1/relay`): the relay wants a session
 * and an `Origin` equal to the web origin, and this page is served from port 5178, so start the
 * API Worker as `WEB_ORIGIN=http://localhost:5178 pnpm -F @yozz.app/worker-api dev`, sign up
 * against it (the magic link prints in that terminal), and pass the `better-auth.session_token`
 * cookie value as `--cookie`.
 *
 * Node's WebCrypto is not Chromium's, WebKit's or Gecko's; see DECISIONS.md, "Live hosts must
 * greet, not merely handshake".
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { errorText } from '../describe.ts';
import { HOSTS } from '../hosts.ts';
import type { HostResult } from './page.ts';

const ENGINES = { chromium, firefox, webkit };
type EngineName = keyof typeof ENGINES;

const PAGE_PORT = 5178;
const BRIDGE_PORT = 8178;
const BRIDGE_KEY = 'm8-local';
const WORKER_DIR = fileURLToPath(new URL('../../../../spikes/relay/worker', import.meta.url));

const argOf = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
};

/** The spike Worker under local workerd, where `cloudflare:sockets` `connect` works. */
const startBridge = async (): Promise<() => void> => {
  const wrangler = spawn(
    'pnpm',
    [
      'exec',
      'wrangler',
      'dev',
      '--port',
      String(BRIDGE_PORT),
      '--var',
      `SPIKE_KEY:${BRIDGE_KEY}`,
      // The spike's `compatibility_date` is ahead of the catalog's workerd, which refuses a date
      // from its future. If this errors, workerd prints the newest date it knows; use that.
      '--compatibility-date',
      '2026-06-24',
    ],
    {
      cwd: WORKER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      // Its own process group: killing the `pnpm exec wrangler` wrapper leaves `workerd` on the port.
      detached: true,
    },
  );
  const log: string[] = [];
  for (const stream of [wrangler.stdout, wrangler.stderr]) {
    stream.on('data', (chunk: Buffer) => log.push(chunk.toString()));
  }

  // 426 is the Worker answering: key accepted, target allowed, not an upgrade.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (wrangler.exitCode !== null) throw new Error(`wrangler exited:\n${log.join('')}`);
    try {
      const probe = await fetch(
        `http://localhost:${BRIDGE_PORT}/?key=${BRIDGE_KEY}&target=posteo.de:993`,
      );
      if (probe.status === 426) break;
      throw new Error(`bridge answered ${probe.status}: ${await probe.text()}`);
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`bridge never came up:\n${log.join('')}\n${error}`);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return async () => {
    if (wrangler.pid !== undefined) {
      try {
        process.kill(-wrangler.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    if (wrangler.exitCode === null) {
      await new Promise<void>(resolve => wrangler.once('exit', () => resolve()));
    }
  };
};

const relayFlag = argOf('--relay');
const bridgeFlag = argOf('--bridge');
const cookieFlag = argOf('--cookie');

const isRelay = relayFlag !== undefined;
const endpointUrl = relayFlag ?? bridgeFlag ?? `ws://localhost:${BRIDGE_PORT}/?key=${BRIDGE_KEY}`;

const engines: readonly EngineName[] = (() => {
  const only = argOf('--engine');
  if (only === undefined) return Object.keys(ENGINES) as EngineName[];
  if (!(only in ENGINES))
    throw new Error(`unknown engine ${only}; want one of ${Object.keys(ENGINES).join(', ')}`);
  return [only as EngineName];
})();

const stopBridge = isRelay || bridgeFlag !== undefined ? async () => {} : await startBridge();

const vite = await createServer({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Without `strictPort` Vite serves on 5179 while every `page.goto` asks 5178.
  server: { port: PAGE_PORT, strictPort: true },
  // No vite.config.ts of its own; searching upward would find the web app's.
  configFile: false,
});
await vite.listen();

let failures = 0;

/** Every pin each engine derived, by host. */
const pinsByHost = new Map<string, Map<string, string>>();

try {
  for (const name of engines) {
    const browser = await ENGINES[name].launch();
    const context = await browser.newContext();
    if (cookieFlag !== undefined) {
      await context.addCookies([
        {
          name: 'better-auth.session_token',
          value: cookieFlag,
          domain: 'localhost',
          path: '/',
        },
      ]);
    }
    const page = await context.newPage();
    const consoleLog: string[] = [];
    page.on('console', message => consoleLog.push(`  console: ${message.text()}`));
    page.on('pageerror', error => consoleLog.push(`  pageerror: ${error.message}`));

    console.log(`\n${name} ${await browser.version()}`);
    // Counted from what came back, so a batch that dies part-way counts every host it never reached.
    let succeeded = 0;
    try {
      await page.goto(`http://localhost:${PAGE_PORT}/`);
      const results = await page.evaluate(
        ([endpoint, hosts, relayMode]) =>
          window.yozzHandshake(endpoint as string, hosts as string[], relayMode as boolean),
        [endpointUrl, HOSTS, isRelay] as const,
      );
      for (const result of results as readonly HostResult[]) {
        if (result.ok) succeeded += 1;
        console.log(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.host.padEnd(22)} ${result.detail}`);
        if (result.greeting !== '') console.log(`        ${result.greeting.slice(0, 68)}`);
        if (result.pin !== null) {
          const perEngine = pinsByHost.get(result.host) ?? new Map<string, string>();
          perEngine.set(name, result.pin);
          pinsByHost.set(result.host, perEngine);
        }
      }
    } catch (error) {
      console.log(`  FAIL  ${errorText(error)}`);
      console.log(consoleLog.join('\n'));
    } finally {
      failures += HOSTS.length - succeeded;
      await context.close();
      await browser.close();
    }
  }
} finally {
  await vite.close();
  await stopBridge();
}

console.log(
  `\n${engines.length * HOSTS.length - failures}/${engines.length * HOSTS.length} handshakes`,
);

/** A host with more than one pin across engines fails the run: a stored pin is then only as good as the browser that stored it. */
const splitPins = [...pinsByHost]
  .filter(([, perEngine]) => perEngine.size > 1 && new Set(perEngine.values()).size > 1)
  .map(([host, perEngine]) => `${host}: ${[...perEngine].map(([e, p]) => `${e}=${p}`).join(' ')}`);

if (splitPins.length > 0) {
  console.log(`\nSPLIT PINS — the engines disagree about ${splitPins.length} host(s):`);
  for (const line of splitPins) console.log(`  ${line}`);
} else if (pinsByHost.size > 0) {
  const compared = [...pinsByHost.values()].filter(perEngine => perEngine.size > 1).length;
  console.log(`${compared}/${pinsByHost.size} hosts answered in >1 engine, one pin each`);
}

process.exit(failures === 0 && splitPins.length === 0 ? 0 : 1);
