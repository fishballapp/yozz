/**
 * A draft's files end to end: real Chromium through the app, the real Worker under `wrangler dev`
 * with its local D1 and R2 (so the cross-origin PUT runs in a browser), and the real CLI bundle.
 * Starts everything it needs on ports of its own, and stops them. No real mail goes anywhere.
 *
 * What stands in: the mail servers are a local TLS SMTP and IMAP server under a test CA. The browser's
 * own TLS stack speaks to them, with that CA as its only trust anchor (a Vite plugin here, nothing in
 * the app), through a WebSocket route in place of the Worker's relay, which by design reaches public
 * addresses only. Both listen on their real ports, 465 and 993, where the CLI reaches them directly
 * over `node:tls`.
 *
 * `YOZZ_CAPTURES=<dir>` also saves the screenshots a pull request shows.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type BrowserContext, chromium, type Download, type Page } from '@playwright/test';
import PostalMime from 'postal-mime';
import { createServer as createViteServer, type Plugin } from 'vite';

type UnlockModule = typeof import('../src/vault/unlock');
type AuthModule = typeof import('../src/vault/auth-client');
type CollectModule = typeof import('@yozz.app/mail/vault/collect-files');
type SnapshotModule = typeof import('@yozz.app/mail/threads/cache-snapshot');
const UNLOCK = '/src/vault/unlock.ts' as string;
const AUTH = '/src/vault/auth-client.ts' as string;
const COLLECT = `/@fs${fileURLToPath(import.meta.resolve('@yozz.app/mail/vault/collect-files'))}`;
const SNAPSHOT = `/@fs${fileURLToPath(import.meta.resolve('@yozz.app/mail/threads/cache-snapshot'))}`;

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_APP = resolve(HERE, '..');
const CLI_APP = resolve(HERE, '../../cli');

const WEB_PORT = 15177;
const API_PORT = 18177;
const WEB = `http://localhost:${WEB_PORT}`;
const API = `http://localhost:${API_PORT}`;
const SMTP_PORT = 465;
const IMAP_PORT = 993;

const EMAIL = `drive-files-${Date.now()}@example.com`;
const PASSWORD = 'correct horse';
const SEND_ONLY = 'out@fishball.test';
const MAILBOX = 'inbox@fishball.test';
const RECIPIENT = 'kate@example.com';

const captures = process.env.YOZZ_CAPTURES;

const passed: string[] = [];
const ok = (label: string) => {
  passed.push(label);
  console.log(`✓ ${label}`);
};
const assert = (label: string, condition: boolean, detail: unknown = '') => {
  if (!condition) throw new Error(`✗ ${label} ${detail === '' ? '' : JSON.stringify(detail)}`);
  ok(label);
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// ---- The test CA and the mail servers ----

const makeCertificates = (dir: string) => {
  const run = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
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
      'subjectAltName=DNS:localhost',
      'subjectKeyIdentifier=hash',
      'authorityKeyIdentifier=keyid',
      '',
    ].join('\n'),
  );
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
  run('req', '-new', '-key', 'ca.key', '-subj', '/CN=YOZZ drive CA', '-out', 'ca.csr');
  run(
    'x509',
    '-req',
    '-in',
    'ca.csr',
    '-signkey',
    'ca.key',
    '-days',
    '2',
    '-extfile',
    'ca.ext',
    '-out',
    'ca.pem',
  );
  run('x509', '-in', 'ca.pem', '-outform', 'DER', '-out', 'ca.der');
  run('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key');
  run('req', '-new', '-key', 'leaf.key', '-subj', '/CN=localhost', '-out', 'leaf.csr');
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    'leaf.ext',
    '-out',
    'leaf.pem',
  );
  return {
    caPem: join(dir, 'ca.pem'),
    caDer: readFileSync(join(dir, 'ca.der')),
    key: readFileSync(join(dir, 'leaf.key')),
    cert: readFileSync(join(dir, 'leaf.pem')),
  };
};

type Received = { readonly from: string; readonly to: readonly string[]; readonly raw: Buffer };

/** Greeting, EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT. Latin-1 keeps the bytes as they came. */
const smtpSession = (socket: TLSSocket, received: Received[], declared: { limit: number }) => {
  let buffer = '';
  let from = '';
  let to: string[] = [];
  let data: string[] | null = null;
  socket.write('220 smtp.drive ESMTP ready\r\n');
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('latin1');
    for (;;) {
      const end = buffer.indexOf('\r\n');
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data !== null) {
        if (line === '.') {
          received.push({ from, to, raw: Buffer.from(data.join('\r\n'), 'latin1') });
          data = null;
          socket.write('250 OK queued\r\n');
        } else {
          data.push(line.startsWith('..') ? line.slice(1) : line);
        }
        continue;
      }
      switch (line.split(' ')[0]?.toUpperCase()) {
        case 'EHLO':
          socket.write(`250-smtp.drive\r\n250-SIZE ${declared.limit}\r\n250 AUTH PLAIN LOGIN\r\n`);
          break;
        case 'AUTH':
          socket.write('235 Authenticated\r\n');
          break;
        case 'MAIL':
          from = /<([^>]*)>/u.exec(line)?.[1] ?? '';
          to = [];
          socket.write('250 OK\r\n');
          break;
        case 'RCPT':
          to.push(/<([^>]*)>/u.exec(line)?.[1] ?? '');
          socket.write('250 OK\r\n');
          break;
        case 'DATA':
          data = [];
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          break;
        case 'QUIT':
          socket.end('221 Bye\r\n');
          break;
        default:
          socket.write('500 Unknown command\r\n');
      }
    }
  });
};

/** The CLI's in-memory IMAP server, over TLS: the same one the CLI's own tests run against. */
const imapServerFor = async (tlsOptions: { key: Buffer; cert: Buffer }) => {
  // By a path TypeScript does not follow: another app's test server, outside this project.
  const modulePath = resolve(CLI_APP, 'src/mail/fake-imap-server.ts') as string;
  const { makeFakeImapServer } = (await import(modulePath)) as {
    readonly makeFakeImapServer: (login: { username: string; password: string }) => {
      readonly deliver: (
        folderName: string,
        message: {
          from: string;
          fromName: string;
          to: string;
          subject: string;
          messageId: string;
          date: string;
          text: string;
        },
      ) => number;
      readonly folders: ReadonlyMap<
        string,
        { readonly messages: readonly { readonly raw: Uint8Array }[] }
      >;
      readonly open: () => {
        readonly duplex: {
          readonly read: () => Promise<Uint8Array | null>;
          readonly write: (bytes: Uint8Array) => Promise<void>;
        };
        readonly destroy: () => void;
      };
    };
  };
  const imap = makeFakeImapServer({ username: MAILBOX, password: 'secret' });
  const server = createTlsServer({ ...tlsOptions, minVersion: 'TLSv1.3' }, socket => {
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
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    // On its own port, like SMTP: the CLI reads it directly.
    server.listen(IMAP_PORT, done);
  });
  return { imap, server };
};

/** Pipes the relay's WebSocket to a local server, acknowledging writes as the Worker's relay does. */
const routeRelay = async (
  context: BrowserContext,
  portFor: (relayPort: string) => number,
): Promise<void> => {
  await context.routeWebSocket(/\/api\/v1\/relay/u, socket => {
    const target = portFor(new URL(socket.url()).searchParams.get('port') ?? '');
    const upstream = netConnect({ host: '127.0.0.1', port: target });
    let written = 0;
    upstream.on('data', data => socket.send(data));
    upstream.on('close', () => void socket.close());
    upstream.on('error', () => void socket.close());
    socket.onMessage(message => {
      const bytes = typeof message === 'string' ? Buffer.from(message) : message;
      upstream.write(bytes, () => {
        written += bytes.length;
        socket.send(String(written));
      });
    });
    socket.onClose(() => upstream.destroy());
  });
};

// ---- The servers under the app ----

/** Replaces only where the browser's TLS stack reads its trust anchors from. */
const trustOnly = (caDer: Buffer): Plugin => ({
  name: 'yozz-drive-trust-anchors',
  enforce: 'pre',
  resolveId: (id, importer) =>
    id === './anchors' && importer?.endsWith('relay/connection.ts') === true
      ? '\0yozz-drive-anchors'
      : null,
  load: id =>
    id === '\0yozz-drive-anchors'
      ? `import { compileAnchors, indexAnchors } from '@yozz.app/x509';
         const der = Uint8Array.fromBase64(${JSON.stringify(caDer.toString('base64'))});
         const { source } = compileAnchors(indexAnchors([{ id: 'drive', der }]));
         export const trustAnchors = async () => source;`
      : null,
});

const waitForHttp = async (url: string, label: string) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const answered = await fetch(url)
      .then(() => true)
      .catch(() => false);
    if (answered) return;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`${label} never answered at ${url}`);
};

const startWorker = async (persistTo: string): Promise<ChildProcess> => {
  const wrangler = ['-F', '@yozz.app/worker-api', 'exec', 'wrangler'];
  execFileSync(
    'pnpm',
    [...wrangler, 'd1', 'migrations', 'apply', 'yozz', '--local', '--persist-to', persistTo],
    { stdio: 'pipe', env: { ...process.env, CI: '1' } },
  );
  const worker = spawn(
    'pnpm',
    [
      ...wrangler,
      'dev',
      '--port',
      String(API_PORT),
      '--persist-to',
      persistTo,
      '--var',
      `WEB_ORIGIN:${WEB}`,
      '--var',
      `BASE_URL:${API}`,
      '--var',
      `BETTER_AUTH_SECRET:${randomBytes(32).toString('hex')}`,
    ],
    { cwd: WEB_APP, detached: true, stdio: 'ignore' },
  );
  await waitForHttp(`${API}/api/v1/autoconfig`, 'the Worker');
  return worker;
};

/** A process group of our own, so wrangler's `workerd` goes with it, and nobody else's. */
const stop = (child: ChildProcess | null) => {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
};

// ---- The account ----

const signUp = async (page: Page, persistTo: string) => {
  await page.goto(`${WEB}/`);
  await page.evaluate(
    async ({ email, AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      const answer = await auth.requestSignupLink(email);
      if (answer.error) throw new Error(answer.error.message);
    },
    { email: EMAIL, AUTH },
  );
  const out = execFileSync(
    'pnpm',
    [
      '-F',
      '@yozz.app/worker-api',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'yozz',
      '--local',
      '--persist-to',
      persistTo,
      '--json',
      '--command',
      'SELECT identifier FROM verification ORDER BY createdAt DESC LIMIT 1',
    ],
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(out.slice(out.indexOf('[')))[0]?.results as { identifier: string }[];
  const token = rows[0]?.identifier;
  if (token === undefined) throw new Error('no magic link in the local D1');
  await page.goto(
    `${API}/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(`${WEB}/`)}`,
  );
  await page.evaluate(
    async ({ password, addresses, UNLOCK, AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      const unlock = (await import(UNLOCK)) as UnlockModule;
      const { data } = await auth.getSession();
      if (!data) throw new Error('the magic link signed nobody in');
      const session = await unlock.createPasswordVault({
        account: { userId: data.user.id, email: data.user.email },
        password,
      });
      for (const address of addresses) {
        await session.store.put({
          type: 'address',
          naturalKey: address.address,
          plaintext: JSON.stringify(address),
          precondition: { expect: 'absent' },
        });
      }
    },
    {
      password: PASSWORD,
      UNLOCK,
      AUTH,
      addresses: [
        {
          address: SEND_ONLY,
          senderName: 'Sample Sender',
          smtp: { host: 'localhost', port: SMTP_PORT, username: SEND_ONLY, password: 'secret' },
        },
        {
          address: MAILBOX,
          senderName: 'Sample Sender',
          smtp: { host: 'localhost', port: SMTP_PORT, username: MAILBOX, password: 'secret' },
          imap: { host: 'localhost', port: IMAP_PORT, username: MAILBOX, password: 'secret' },
        },
      ],
    },
  );
};

const logIn = async (page: Page) => {
  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email address').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(/\/m\//u, { timeout: 30_000 });
};

// ---- The composer ----

const openComposer = async (
  page: Page,
  { from, subject, body = 'See attached.' }: { from: string; subject: string; body?: string },
) => {
  await page.goto(`${WEB}/m/unified?compose=new`);
  await page.waitForSelector('#compose-to', { timeout: 30_000 });
  const trigger = page.getByRole('dialog').getByRole('combobox').first();
  if (!(await trigger.innerText()).includes(from)) {
    await trigger.click();
    await page.getByRole('option', { name: new RegExp(from, 'u') }).click();
  }
  await page.locator('#compose-to').fill(RECIPIENT);
  await page.locator('#compose-subject').fill(subject);
  await page.getByLabel('Message body, markdown').fill(body);
};

const pick = (page: Page, files: readonly { name: string; bytes: Uint8Array }[]) =>
  page.locator('input[type="file"]').setInputFiles(
    files.map(({ name, bytes }) => ({
      name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(bytes),
    })),
  );

const chipOf = (page: Page, name: string) =>
  page.getByRole('dialog').getByRole('listitem').filter({ hasText: name });

const waitForUpload = (page: Page, name: string) =>
  chipOf(page, name)
    .getByRole('button', { name: new RegExp(`^Download ${name}`, 'u') })
    .waitFor({
      timeout: 60_000,
    });

const press = (page: Page, name: string) =>
  page.getByRole('dialog').getByRole('button', { name, exact: true }).click();

const savedBytes = async (download: Download) => {
  const path = await download.path();
  return readFileSync(path);
};

const attachmentIn = async (message: Received, name: string) => {
  const parsed = await PostalMime.parse(new Uint8Array(message.raw));
  const found = parsed.attachments.find(({ filename }) => filename === name);
  if (found === undefined) throw new Error(`${name} is not in the message`);
  return new Uint8Array(found.content as ArrayBuffer);
};

const untilReceived = async (received: Received[], count: number) => {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (received.length >= count) return;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`the server took ${received.length} messages, not ${count}`);
};

/** Saves a capture cropped to what changed, when a run asks for them. */
const capture = async (
  page: Page,
  name: string,
  locate: (page: Page) => ReturnType<Page['locator']> = current =>
    current.getByRole('dialog').first(),
) => {
  if (captures === undefined) return;
  mkdirSync(captures, { recursive: true });
  await page.mouse.move(0, 0);
  await locate(page).screenshot({ path: join(captures, `${name}.png`) });
};

const composerFoot = (page: Page) =>
  page.getByRole('dialog').first().locator('div:has(> ul)').first();

// ---- The run ----

const withViewports = async (
  page: Page,
  run: (width: 'desktop' | 'phone') => Promise<void>,
): Promise<void> => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await run('desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await run('phone');
  await page.setViewportSize({ width: 1280, height: 800 });
};

/** The files that hold a mailbox's list snapshot, which no attachment check counts. */
const snapshotFiles = new Set<string>();
const fileIdOf = (url: string) => new URL(url).pathname.split('/').at(-1) ?? '';

/** Every request a page makes for one attachment file, as the Worker answered it. */
const watchFiles = (page: Page) => {
  const traffic: { method: string; url: string; status: number }[] = [];
  page.on('response', response => {
    if (!/\/api\/v1\/vault\/files\/[^/]+$/u.test(response.url())) return;
    traffic.push({
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
    });
  });
  return () => traffic.filter(({ url }) => !snapshotFiles.has(fileIdOf(url)));
};

/** Waits for the vault to name a list snapshot file not noted yet, and notes the files it names. */
const learnSnapshots = async (page: Page) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const fileIds = await page.evaluate(
      async ({ UNLOCK, SNAPSHOT }) => {
        const unlock = (await import(UNLOCK)) as UnlockModule;
        const snapshot = (await import(SNAPSHOT)) as SnapshotModule;
        const session = await unlock.resumeSession();
        if (session === null) throw new Error('no session to read the snapshots in');
        const rows = await session.store.list(snapshot.CACHE_SNAPSHOT_RECORD_TYPE);
        return rows.flatMap(
          ({ plaintext }) => snapshot.parseSnapshotRecord(plaintext)?.fileId ?? [],
        );
      },
      { UNLOCK, SNAPSHOT },
    );
    if (fileIds.some(id => !snapshotFiles.has(id))) {
      for (const id of fileIds) snapshotFiles.add(id);
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error('no list snapshot reached the vault');
};

/** Mail in the demo inbox, so a list snapshot has something to show. */
const DEMO_INBOX = [
  {
    fromName: 'Northwind Coffee',
    from: 'orders@northwind.test',
    subject: 'Your beans ship Tuesday',
    text: 'Two bags of the Ethiopia Guji roast are packed and leave the roastery on Tuesday.',
  },
  {
    fromName: 'Priya Raman',
    from: 'priya@studio-raman.test',
    subject: 'Logo round two',
    text: 'Three directions attached in the shared folder; the second one is my favourite.',
  },
  {
    fromName: 'Harbour Dental',
    from: 'reminders@harbourdental.test',
    subject: 'Check-up on 18 November, 9:30',
    text: 'Reply C to confirm or R to rearrange.',
  },
].map((message, index) => ({
  ...message,
  to: MAILBOX,
  messageId: `<demo-${index}@fishball.test>`,
  date: `Fri, 0${index + 4} Nov 2026 09:0${index}:00 +0000`,
}));

/** Mail that arrives after a device last synced, which only the vault's snapshot can show it. */
const LATE_MAIL = {
  fromName: 'Aurora Rail',
  from: 'trips@aurorarail.test',
  subject: 'Window seat confirmed',
  text: 'Coach C, seat 42, on the 08:15 to Edinburgh on Saturday.',
  to: MAILBOX,
  messageId: '<demo-late@fishball.test>',
  date: 'Fri, 07 Nov 2026 09:03:00 +0000',
};

/** Dates the mailbox's snapshot record back past the write interval, so the next sync replaces it. */
const ageSnapshot = (page: Page) =>
  page.evaluate(
    async ({ UNLOCK, SNAPSHOT, MAILBOX }) => {
      const unlock = (await import(UNLOCK)) as UnlockModule;
      const snapshot = (await import(SNAPSHOT)) as SnapshotModule;
      const session = await unlock.resumeSession();
      if (session === null) throw new Error('no session to age the snapshot in');
      const row = await session.store.get(snapshot.CACHE_SNAPSHOT_RECORD_TYPE, MAILBOX);
      const record = row === null ? null : snapshot.parseSnapshotRecord(row.plaintext);
      if (row === null || record === null) throw new Error('no snapshot to age');
      await session.store.put({
        type: snapshot.CACHE_SNAPSHOT_RECORD_TYPE,
        naturalKey: MAILBOX,
        plaintext: JSON.stringify({ ...record, writtenAt: 0 }),
        precondition: { expect: 'revision', revision: row.revision },
      });
    },
    { UNLOCK, SNAPSHOT, MAILBOX },
  );

/**
 * A browser profile whose mail server never answers: the relay's WebSocket opens and nothing goes
 * through it. Whatever its list shows came from the vault.
 */
const unreachableProfile = async (browser: Awaited<ReturnType<typeof chromium.launch>>) => {
  const context = await browser.newContext();
  await context.routeWebSocket(/\/api\/v1\/relay/u, () => {});
  return context;
};

const main = async () => {
  const root = mkdtempSync(join(tmpdir(), 'yozz-attachment-drive-'));
  const persistTo = join(root, 'wrangler');
  const certificates = makeCertificates(root);
  const tlsOptions = { key: certificates.key, cert: certificates.cert };
  const received: Received[] = [];
  // Gmail's, which a 25 MiB file fits inside by about 10 KB.
  const declared = { limit: 35_882_577 };
  const smtp = createTlsServer({ ...tlsOptions, minVersion: 'TLSv1.3' }, socket =>
    smtpSession(socket, received, declared),
  );
  await new Promise<void>((done, fail) => {
    smtp.once('error', fail);
    // All interfaces: macOS lets anyone bind a low port only there. It takes mail from nobody real.
    smtp.listen(SMTP_PORT, done);
  });
  const { imap, server: imapServer } = await imapServerFor(tlsOptions);
  for (const message of DEMO_INBOX) imap.deliver('INBOX', message);

  let worker: ChildProcess | null = null;
  process.env.VITE_API_URL = API;
  const vite = await createViteServer({
    root: WEB_APP,
    configFile: join(WEB_APP, 'vite.config.ts'),
    server: { port: WEB_PORT, strictPort: true },
    plugins: [trustOnly(certificates.caDer)],
    logLevel: 'error',
  });
  const browser = await chromium.launch({ args: ['--mute-audio'] });

  try {
    worker = await startWorker(persistTo);
    await vite.listen();

    const portFor = (relayPort: string) =>
      relayPort === String(IMAP_PORT) ? IMAP_PORT : SMTP_PORT;
    const laptop = await browser.newContext({ acceptDownloads: true });
    const phone = await browser.newContext({ acceptDownloads: true });
    await routeRelay(laptop, portFor);
    await routeRelay(phone, portFor);
    const page = await laptop.newPage();
    const filesTraffic = watchFiles(page);
    const gets = () => filesTraffic().filter(({ method }) => method === 'GET');

    await signUp(page, persistTo);

    // ---- A new device shows the inbox from the vault's snapshot of its list ----
    const subjectOf = (current: Page, subject: string) =>
      current.getByText(subject, { exact: true }).first();
    const freshBefore = await unreachableProfile(browser);
    const before = await freshBefore.newPage();
    await logIn(before);
    await before.waitForTimeout(3_000);
    assert(
      'with no snapshot yet, a device whose server does not answer shows no mail',
      !(await subjectOf(before, 'Logo round two').isVisible()),
    );
    await withViewports(before, width =>
      capture(before, `snapshot-before-${width}`, current => current.locator('body')),
    );
    await freshBefore.close();

    await logIn(page);
    ok('signed up and logged in against the local Worker');
    await subjectOf(page, 'Logo round two').waitFor({ timeout: 30_000 });
    await learnSnapshots(page);
    ok('a sync writes the list snapshot to the vault');

    const freshAfter = await unreachableProfile(browser);
    const after = await freshAfter.newPage();
    await logIn(after);
    await subjectOf(after, 'Logo round two').waitFor({ timeout: 10_000 });
    ok('a new device whose server does not answer shows the inbox from the snapshot');
    await withViewports(after, width =>
      capture(after, `snapshot-after-${width}`, current => current.locator('body')),
    );

    // ---- A device with an older cache shows the newer list from the vault's snapshot ----
    imap.deliver('INBOX', LATE_MAIL);
    await ageSnapshot(page);
    await page.reload();
    await subjectOf(page, LATE_MAIL.subject).waitFor({ timeout: 30_000 });
    await learnSnapshots(page);
    ok('a device that synced the new mail writes a newer snapshot');
    await withViewports(after, width =>
      capture(after, `stale-before-${width}`, current => current.locator('body')),
    );
    assert(
      'before it reloads, that device shows the list it last had',
      !(await subjectOf(after, LATE_MAIL.subject).isVisible()),
    );
    await after.reload();
    await subjectOf(after, LATE_MAIL.subject).waitFor({ timeout: 10_000 });
    ok('a device with an older cache whose server does not answer shows the newer list');
    await withViewports(after, width =>
      capture(after, `stale-after-${width}`, current => current.locator('body')),
    );
    await freshAfter.close();

    // Over 1 MB, which the old ~400 KB wall refused as a connection error.
    const report = { name: 'report.bin', bytes: new Uint8Array(randomBytes(1_500_000)) };

    // ---- Attach, reload, still there ----
    await openComposer(page, { from: SEND_ONLY, subject: 'Quarterly report' });
    await pick(page, [report]);
    await waitForUpload(page, report.name);
    const puts = filesTraffic().filter(({ method }) => method === 'PUT');
    assert('the cross-origin PUT reached the Worker from a browser', puts.length === 1, puts);
    assert('and the Worker stored it', puts[0]?.status === 200, puts);
    assert('Web and API are different origins', new URL(WEB).origin !== new URL(API).origin);

    // Past the 2 s autosave, so the record names the file on every device.
    await page.waitForTimeout(3_500);
    await page.reload();
    await page.waitForSelector('#compose-to', { timeout: 30_000 });
    await waitForUpload(page, report.name);
    ok('a reload keeps the chip');
    assert(
      'and a reload uploads nothing again',
      filesTraffic().filter(f => f.method === 'PUT').length === 1,
    );

    // What R2 holds is the file's size plus the IV and tag, and none of its bytes.
    const stored = await page.evaluate(
      async ({ UNLOCK, fileId }) => {
        const unlock = (await import(UNLOCK)) as UnlockModule;
        const session = await unlock.resumeSession();
        if (session === null) throw new Error('no session to read the listing in');
        const { files } = await session.files.list();
        return files.find(({ id }) => id === fileId)?.size ?? null;
      },
      { UNLOCK, fileId: new URL(puts[0]?.url ?? '').pathname.split('/').at(-1) ?? '' },
    );
    assert(
      'the Worker holds it sealed: its size is the IV and tag larger',
      stored === report.bytes.length + 28,
      stored,
    );

    // ---- A second profile sees the draft and its chip ----
    const secondDevice = await phone.newPage();
    const secondTraffic = watchFiles(secondDevice);
    await logIn(secondDevice);
    await secondDevice.goto(`${WEB}/m/drafts`);
    await secondDevice
      .getByRole('link', { name: /Quarterly report/u })
      .first()
      .click();
    await secondDevice.getByRole('link', { name: 'Edit draft' }).click();
    await secondDevice.waitForSelector('#compose-to', { timeout: 30_000 });
    await waitForUpload(secondDevice, report.name);
    ok('a second browser profile opens the draft with its chip');
    assert(
      'and it has downloaded nothing to show it',
      secondTraffic().length === 0,
      secondTraffic(),
    );
    const [onSecond] = await Promise.all([
      secondDevice.waitForEvent('download'),
      chipOf(secondDevice, report.name)
        .getByRole('button', { name: /^Download/u })
        .click(),
    ]);
    assert(
      'the second profile opens the file, the same bytes',
      sha256(await savedBytes(onSecond)) === sha256(report.bytes),
    );
    await secondDevice.close();

    // ---- Send from the tab that reloaded: the bytes come from R2 ----
    await press(page, 'Send');
    await untilReceived(received, 1);
    const [first] = received;
    if (first === undefined) throw new Error('nothing received');
    assert('Send went to SMTP as the address', first.from === SEND_ONLY, first.from);
    assert(
      'the received bytes contain the file intact',
      sha256(await attachmentIn(first, report.name)) === sha256(report.bytes),
    );
    assert('a reloaded tab read the file from R2', gets().length === 1, gets());

    // ---- A send-only Sent copy shows its chip and downloads ----
    await page.goto(`${WEB}/m/sent`);
    await page
      .getByRole('link', { name: /Quarterly report/u })
      .first()
      .click();
    const sentChip = page.getByRole('button', { name: /^Download report\.bin/u });
    await sentChip.waitFor({ timeout: 30_000 });
    ok('the send-only Sent copy shows its chip');
    await withViewports(page, async width => {
      if (captures === undefined) return;
      mkdirSync(captures, { recursive: true });
      await page.mouse.move(0, 0);
      const chipBox = await sentChip.boundingBox();
      const viewport = page.viewportSize();
      if (chipBox === null || viewport === null) throw new Error('no chip on screen');
      const left = width === 'desktop' ? Math.max(0, chipBox.x - 24) : 0;
      await page.screenshot({
        path: join(captures, `sent-chip-${width}.png`),
        clip: {
          x: left,
          y: chipBox.y - 96,
          width: Math.min(viewport.width - left, 520),
          height: 148,
        },
      });
    });
    const [fromSent] = await Promise.all([page.waitForEvent('download'), sentChip.click()]);
    assert(
      'the chip downloads from R2, the same bytes',
      sha256(await savedBytes(fromSent)) === sha256(report.bytes),
    );

    // ---- A message over what the server takes: refused, and the draft comes back with its file ----
    declared.limit = 1_000_000;
    const oversized = { name: 'oversized.bin', bytes: new Uint8Array(randomBytes(1_200_000)) };
    await openComposer(page, { from: SEND_ONLY, subject: 'Oversized' });
    await pick(page, [oversized]);
    await waitForUpload(page, oversized.name);
    await press(page, 'Send');
    const refusal = page.getByText('accepts messages up to 1 MB, and this one is larger');
    await refusal.first().waitFor({ timeout: 60_000 });
    ok('a message over the server’s SIZE is refused with its own sentence');
    assert('and nothing was written to the server', received.length === 1, received.length);
    await withViewports(page, width =>
      capture(page, `too-large-${width}`, current =>
        current
          .getByRole('dialog')
          .or(current.getByRole('region'))
          .filter({ hasText: 'Not sent' })
          .last(),
      ),
    );
    // By its text: Base UI hides a high-priority toast's plate from the accessibility tree.
    await page.locator('button', { hasText: 'Reopen' }).click();
    await page.waitForSelector('#compose-to', { timeout: 30_000 });
    await waitForUpload(page, oversized.name);
    ok('the draft comes back, with its chip');
    declared.limit = 35_882_577;
    await press(page, 'Send');
    await untilReceived(received, 2);
    const oversizedSent = received[1];
    if (oversizedSent === undefined) throw new Error('nothing received');
    assert(
      'and it sends once the server takes it, the file intact',
      sha256(await attachmentIn(oversizedSent, oversized.name)) === sha256(oversized.bytes),
    );

    // ---- A file that can't be fetched back at Send: nothing goes out, and the draft comes back ----
    const unreachable = { name: 'unreachable.bin', bytes: new Uint8Array(randomBytes(4_000)) };
    await openComposer(page, { from: SEND_ONLY, subject: 'Unreachable' });
    await pick(page, [unreachable]);
    await waitForUpload(page, unreachable.name);
    await page.waitForTimeout(3_500);
    // A reload, so this tab no longer holds the bytes and has to read R2.
    await page.reload();
    await page.waitForSelector('#compose-to', { timeout: 30_000 });
    await waitForUpload(page, unreachable.name);
    const fileRoute = /\/api\/v1\/vault\/files\/[^/]+$/u;
    await page.route(fileRoute, intercepted =>
      intercepted.request().method() === 'GET' ? intercepted.abort() : intercepted.fallback(),
    );
    const receivedBefore = received.length;
    await press(page, 'Send');
    await page
      .getByText(`Couldn’t download ${unreachable.name}. Reopen the draft and try again.`)
      .first()
      .waitFor({ timeout: 60_000 });
    ok('a file that can’t be fetched at Send says so in the toast');
    assert('and nothing was written to the server', received.length === receivedBefore);
    await withViewports(page, width =>
      capture(page, `file-unreachable-${width}`, current =>
        current
          .getByRole('dialog')
          .or(current.getByRole('region'))
          .filter({ hasText: 'Not sent' })
          .last(),
      ),
    );
    await page.unroute(fileRoute);
    await page.locator('button', { hasText: 'Reopen' }).click();
    await page.waitForSelector('#compose-to', { timeout: 30_000 });
    await waitForUpload(page, unreachable.name);
    ok('the draft comes back, with its chip');
    await page.getByRole('dialog').getByRole('button', { name: 'Close draft' }).click();

    // ---- Sending from the tab that attached: nothing is downloaded ----
    const getsBefore = gets().length;
    const invoice = { name: 'invoice.bin', bytes: new Uint8Array(randomBytes(700_000)) };
    await openComposer(page, { from: SEND_ONLY, subject: 'Invoice' });
    await pick(page, [invoice]);
    await waitForUpload(page, invoice.name);
    await press(page, 'Send');
    await untilReceived(received, 3);
    const invoiceSent = received[2];
    if (invoiceSent === undefined) throw new Error('nothing received');
    assert(
      'a send from the same tab carries the file',
      sha256(await attachmentIn(invoiceSent, invoice.name)) === sha256(invoice.bytes),
    );
    assert('and downloads nothing it just uploaded', gets().length === getsBefore, gets());

    // ---- The whole 25 MiB ----
    const largest = { name: 'largest.bin', bytes: new Uint8Array(randomBytes(25 * 1024 * 1024)) };
    await openComposer(page, { from: SEND_ONLY, subject: 'Largest allowed' });
    await pick(page, [largest]);
    await waitForUpload(page, largest.name);
    await press(page, 'Send');
    await untilReceived(received, 4);
    const largestSent = received[3];
    if (largestSent === undefined) throw new Error('nothing received');
    assert(
      'a 25 MiB file goes out intact',
      sha256(await attachmentIn(largestSent, largest.name)) === sha256(largest.bytes),
    );

    // ---- A mailbox address: the Sent copy is the same bytes, and no reference survives ----
    const notes = { name: 'notes.bin', bytes: new Uint8Array(randomBytes(300_000)) };
    await openComposer(page, { from: MAILBOX, subject: 'Notes' });
    await pick(page, [notes]);
    await waitForUpload(page, notes.name);
    await press(page, 'Send');
    await untilReceived(received, 5);
    const notesSent = received[4];
    if (notesSent === undefined) throw new Error('nothing received');
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if ((imap.folders.get('Sent')?.messages.length ?? 0) > 0) break;
      await page.waitForTimeout(500);
    }
    const [appended] = imap.folders.get('Sent')?.messages ?? [];
    if (appended === undefined) throw new Error('nothing was appended to Sent');
    assert(
      'the APPEND to Sent is the bytes SMTP took',
      sha256(appended.raw) === sha256(Buffer.concat([notesSent.raw, Buffer.from('\r\n')])),
    );

    // ---- What the composer says when an upload goes wrong ----
    await page.setViewportSize({ width: 1280, height: 800 });
    const stuck = { name: 'budget.xlsx', bytes: new Uint8Array(randomBytes(2_000)) };
    await openComposer(page, { from: SEND_ONLY, subject: 'Budget' });
    const route = /\/api\/v1\/vault\/files\/[^/]+$/u;
    const release = Promise.withResolvers<void>();
    await page.route(route, async intercepted => {
      if (intercepted.request().method() !== 'PUT') return intercepted.fallback();
      await release.promise;
      return intercepted.fallback();
    });
    await pick(page, [stuck]);
    const uploading = chipOf(page, stuck.name).getByText('Uploading…');
    await uploading.waitFor();
    ok('the chip says it is uploading');
    // The prompt is dismissed, so the reload stops and the upload carries on.
    const prompted = Promise.withResolvers<string>();
    page.once('dialog', dialog => {
      prompted.resolve(dialog.type());
      void dialog.dismiss();
    });
    void page.reload({ timeout: 3_000 }).catch(() => undefined);
    assert('a reload mid-upload asks first', (await prompted.promise) === 'beforeunload');
    await uploading.waitFor();
    await withViewports(page, width => capture(page, `uploading-${width}`, composerFoot));
    release.resolve();
    await page.unroute(route);
    await waitForUpload(page, stuck.name);
    await withViewports(page, width => capture(page, `attached-${width}`, composerFoot));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: `Remove ${stuck.name}` })
      .click();

    await page.route(route, intercepted =>
      intercepted.request().method() === 'PUT' ? intercepted.abort() : intercepted.fallback(),
    );
    await pick(page, [stuck]);
    await chipOf(page, stuck.name).getByText('Upload failed').waitFor();
    await page
      .getByRole('dialog')
      .getByText('Failed to upload. Retry or remove the file.')
      .waitFor();
    ok('a failed upload says so on its chip');
    await withViewports(page, width => capture(page, `failed-${width}`, composerFoot));
    await press(page, 'Send');
    await page
      .getByRole('dialog')
      .getByText('budget.xlsx failed to upload. Retry or remove it before sending.')
      .waitFor();
    ok('Send refuses over a failed upload, and says why');
    await page.unroute(route);
    const putsBeforeRetry = filesTraffic().filter(({ method }) => method === 'PUT');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: `Retry ${stuck.name}` })
      .click();
    await waitForUpload(page, stuck.name);
    const retriedPut = filesTraffic()
      .filter(({ method }) => method === 'PUT')
      .at(-1);
    assert(
      'a retry uploads under a new id',
      retriedPut !== undefined && !putsBeforeRetry.some(({ url }) => url === retriedPut.url),
      retriedPut,
    );
    await page
      .getByRole('dialog')
      .getByRole('button', { name: `Remove ${stuck.name}` })
      .click();

    await page.route(route, intercepted =>
      intercepted.request().method() === 'PUT'
        ? intercepted.fulfill({
            status: 413,
            contentType: 'application/json',
            headers: {
              'access-control-allow-origin': WEB,
              'access-control-allow-credentials': 'true',
            },
            body: JSON.stringify({
              error: { code: 'STORAGE_FULL', message: 'File storage is full' },
            }),
          })
        : intercepted.fallback(),
    );
    await pick(page, [stuck]);
    await chipOf(page, stuck.name).getByText('Storage full').waitFor();
    await page
      .getByRole('dialog')
      .getByText('Failed to upload. Your file storage is full (1 GB).')
      .waitFor();
    ok('a full account says storage is full, not a connection error');
    await withViewports(page, width => capture(page, `storage-full-${width}`, composerFoot));
    await page.unroute(route);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: `Remove ${stuck.name}` })
      .click();

    // ---- Text too long for the claim's record ----
    await page.getByLabel('Message body, markdown').fill('x '.repeat(200_000));
    await press(page, 'Send');
    await page
      .getByRole('dialog')
      .getByText('This message’s text is too long to send. Shorten it or trim the quoted thread.')
      .waitFor({ timeout: 30_000 });
    ok('text over the record limit gets its own sentence');
    await withViewports(page, width =>
      capture(page, `too-long-${width}`, current => current.getByRole('dialog').getByRole('alert')),
    );
    await page.getByLabel('Message body, markdown').fill('Short again.');

    // ---- Collection against the real Worker ----
    await page.waitForTimeout(3_000);
    const collected = await page.evaluate(
      async ({ UNLOCK, COLLECT }) => {
        const unlock = (await import(UNLOCK)) as UnlockModule;
        const { collectFiles } = (await import(COLLECT)) as CollectModule;
        const session = await unlock.resumeSession();
        if (session === null) throw new Error('no session to collect in');
        const before = (await session.files.list()).files.length;
        const early = await collectFiles(session.store, session.files, Date.now());
        const removed = await collectFiles(
          session.store,
          session.files,
          Date.now() + 25 * 60 * 60 * 1000,
        );
        const after = await session.files.list();
        return { before, early, removed, after: after.files.length, used: after.usedBytes };
      },
      { UNLOCK, COLLECT },
    );
    assert('a fresh file is left alone inside its 24 hours', collected.early === 0, collected);
    assert(
      'past them, unreferenced files go and the sent copy’s stays',
      collected.removed > 0 && collected.after >= 1 && collected.after < collected.before,
      collected,
    );
    const [againFromSent] = await (async () => {
      await page.goto(`${WEB}/m/sent`);
      await page
        .getByRole('link', { name: /Quarterly report/u })
        .first()
        .click();
      const chip = page.getByRole('button', { name: /^Download report\.bin/u });
      await chip.waitFor({ timeout: 30_000 });
      return Promise.all([page.waitForEvent('download'), chip.click()]);
    })();
    assert(
      'the send-only copy still downloads after collection',
      sha256(await savedBytes(againFromSent)) === sha256(report.bytes),
    );

    // ---- The CLI against the same Worker ----
    const cliHomes = join(root, 'cli');
    const noOpener = join(root, 'bin');
    mkdirSync(noOpener, { recursive: true });
    // `yozz login` opens the machine's browser; this run answers it in its own.
    writeFileSync(join(noOpener, 'open'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(noOpener, 'open'), 0o755);
    const cliEnv = {
      ...process.env,
      PATH: `${noOpener}:${process.env.PATH ?? ''}`,
      YOZZ_API_URL: API,
      YOZZ_WEB_URL: WEB,
      XDG_CONFIG_HOME: join(cliHomes, 'config'),
      XDG_STATE_HOME: join(cliHomes, 'state'),
      XDG_CACHE_HOME: join(cliHomes, 'cache'),
      NODE_EXTRA_CA_CERTS: certificates.caPem,
    };
    const bin = join(CLI_APP, 'dist/bin.js');
    // Not `execFileSync`: the SMTP server the CLI talks to runs on this process's event loop.
    const yozz = async (...args: string[]) =>
      (await run('node', [bin, ...args], { env: cliEnv, timeout: 120_000 })).stdout;

    const login = spawn('node', [bin, 'login', '--name', 'drive'], { env: cliEnv });
    const url = await new Promise<string>((done, fail) => {
      let printed = '';
      const read = (chunk: Buffer) => {
        printed += chunk.toString();
        const found = /https?:\/\/\S*\/cli\/approve\?\S+/u.exec(printed)?.[0];
        if (found !== undefined) done(found);
      };
      login.stdout.on('data', read);
      login.stderr.on('data', read);
      login.once('exit', () => fail(new Error(`yozz login exited: ${printed}`)));
    });
    await page.goto(url);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await new Promise<void>(done => login.once('exit', () => done()));
    assert('yozz login is approved in the browser', login.exitCode === 0, login.exitCode);

    const cliFile = join(root, 'contract.pdf');
    const contract = new Uint8Array(randomBytes(1_200_000));
    writeFileSync(cliFile, contract);
    const { draft } = JSON.parse(
      await yozz(
        'draft',
        '--from',
        SEND_ONLY,
        '--to',
        RECIPIENT,
        '--subject',
        'Contract',
        '--text',
        'From the terminal.',
        '--attach',
        cliFile,
      ),
    );
    assert(
      'yozz draft --attach names the file',
      draft.attachments?.[0]?.size === contract.length,
      draft.attachments,
    );
    await page.goto(`${WEB}/m/drafts`);
    await page
      .getByRole('link', { name: /Contract/u })
      .first()
      .click();
    await page.getByRole('link', { name: 'Edit draft' }).click();
    await waitForUpload(page, 'contract.pdf');
    ok('a draft the CLI attached to shows its chip in the browser');
    await page.getByRole('dialog').getByRole('button', { name: 'Close draft' }).click();
    await page.waitForTimeout(500);

    const count = received.length;
    declared.limit = 1_000_000;
    const tooLarge = await yozz('send', draft.draftId).then(
      () => null,
      (failure: { stderr?: string }) =>
        JSON.parse(failure.stderr?.trim().split('\n').at(-1) ?? '{}'),
    );
    assert(
      'yozz send over the server’s SIZE is SendRefused, and the draft is back',
      tooLarge?.error?.code === 'SendRefused' &&
        String(tooLarge.error.message).includes('accepts messages up to 1 MB') &&
        received.length === count,
      tooLarge,
    );
    declared.limit = 35_882_577;
    const sent = JSON.parse(await yozz('send', tooLarge.error.currentDraftId));
    assert('yozz send sends', sent.sent === true, sent);
    await untilReceived(received, count + 1);
    const fromCli = received[count];
    if (fromCli === undefined) throw new Error('nothing received');
    assert(
      'the CLI’s message carries the file from R2, intact',
      sha256(await attachmentIn(fromCli, 'contract.pdf')) === sha256(contract),
    );
    const saveDir = join(root, 'saved');
    const read = JSON.parse(await yozz('read', sent.messageId, '--save-attachments', saveDir));
    const saved = read.threads[0]?.messages[0]?.attachments?.[0]?.path as string | undefined;
    assert(
      'yozz read --save-attachments downloads a send-only copy’s file',
      saved !== undefined && sha256(readFileSync(saved)) === sha256(contract),
      read.threads[0]?.messages[0]?.attachments,
    );

    console.log(`\n${passed.length} checks passed`);
  } finally {
    await browser.close();
    await vite.close();
    stop(worker);
    smtp.close();
    imapServer.close();
    rmSync(root, { recursive: true, force: true });
  }
};

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
