/**
 * Pushes large messages through the live yozz.app relay, up and back down, to see whether it drops
 * them.
 *
 * Creates a throwaway Forward Email alias and YOZZ account, deletes both on the way out, and prints
 * no credential. Each size but the last stops before the end of the message, which the server
 * discards (RFC 5321 §4.1.1.4); one real email then goes to the alias itself, and once it has
 * arrived it is fetched whole (`BODY.PEEK[]`) back through the relay and its size compared.
 *
 * This is a Node copy of the browser's pacing logic (`openRelayTransport`), and the download runs
 * unthrottled, so what it shows is the relay's and the clients' behaviour, not a browser's.
 *
 * Needs FORWARD_EMAIL_API_KEY (an API key for the yozz.app domain) in the environment; in the
 * monorepo, from the repo root:
 *   pnpm exec varlock run -- node projects/yozz/packages/imap/harness/relay-load.ts
 */
import { connect, type Socket } from 'node:net';
import { createSmtpClient, formatDate } from '@yozz.app/smtp';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { createImapClient, DEFAULT_MAX_LITERAL_BYTES } from '../src/index.ts';

const MIB = 1024 * 1024;
const ABORT_SIZES_MIB = [1, 5, 10, 25, 35];
// A 25 MiB attachment is about 35 MiB once base64 is inside the email, so that is the real ceiling.
const FULL_SEND_SIZES_MIB = [35, 25, 10];
const API = 'https://api.yozz.app';
// The header that names the account a destructive request acts on.
const ACCOUNT_HEADER = 'Yozz-Account';
const WEB = 'https://yozz.app';
const SMTP_HOST = 'smtp.forwardemail.net';
const IMAP_HOST = 'imap.forwardemail.net';
const SETTLE_MS = 20_000;
const WRITE_WINDOW_BYTES = 512 * 1024;
const ACK_STALL_MS = 60_000;
// The client can wait forever for the server's reply; this keeps the cleanup below reachable.
const SEND_DEADLINE_MS = 5 * 60_000;

const apiKey = process.env.FORWARD_EMAIL_API_KEY;
if (apiKey === undefined || apiKey === '') throw new Error('FORWARD_EMAIL_API_KEY is not loaded');
const FE_ALIASES = 'https://api.forwardemail.net/v1/domains/yozz.app/aliases';
const feHeaders = {
  authorization: `Basic ${btoa(`${apiKey}:`)}`,
  'content-type': 'application/json',
};

const log = (line: string) =>
  console.log(`${Temporal.Now.plainTimeISO('UTC').toString({ smallestUnit: 'second' })} ${line}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const anchors = compileAnchors(ROOT_BUNDLE);

const feRequest = async (method: string, url: string, body?: unknown): Promise<Response> => {
  const response = await fetch(url, {
    method,
    headers: feHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Forward Email ${method} answered ${response.status}`);
  return response;
};
const feCall = async <T>(method: string, url: string, body?: unknown): Promise<T> =>
  (await feRequest(method, url, body)).json();

const tlsDuplex = (connection: TlsConnection): ByteDuplex => ({
  read: async () => {
    const result = await connection.read();
    if (!result.ok || result.kind === 'closed') return null;
    return result.bytes;
  },
  write: async bytes => {
    const result = await connection.write(bytes);
    if (!result.ok) throw new Error(`TLS write error: ${result.reason.kind}`);
  },
});

type Relay = ByteDuplex & {
  readonly flush: () => Promise<void>;
  readonly socket: WebSocket;
  readonly closed: () => { code: number; reason: string } | null;
};

/** The web app's `openRelayTransport` and its pacing, plus the cookie a browser would send. */
const openRelay = (cookie: string, host: string, port: 465 | 993): Promise<Relay> =>
  new Promise((resolve, reject) => {
    const url = `wss://api.yozz.app/api/v1/relay?host=${host}&port=${port}`;
    // @ts-expect-error Node's WebSocket takes headers, which a browser's does not.
    const socket = new WebSocket(url, { headers: { Cookie: cookie, Origin: WEB } });
    socket.binaryType = 'arraybuffer';
    const chunks: Uint8Array[] = [];
    let waiter: ((chunk: Uint8Array | null) => void) | null = null;
    let closed: { code: number; reason: string } | null = null;
    let sentBytes = 0;
    let ackedBytes = 0;
    const ackWaiters: PromiseWithResolvers<void>[] = [];
    let ackStall: ReturnType<typeof setTimeout> | undefined;

    const failAcks = (reason: string) => {
      clearTimeout(ackStall);
      for (const ack of ackWaiters.splice(0)) ack.reject(new Error(reason));
    };
    const waitForAck = (): Promise<void> => {
      if (closed !== null) return Promise.reject(new Error('relay closed'));
      ackStall ??= setTimeout(() => {
        failAcks('relay stopped acknowledging writes');
        socket.close();
      }, ACK_STALL_MS);
      const ack = Promise.withResolvers<void>();
      ackWaiters.push(ack);
      return ack.promise;
    };

    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') {
        ackedBytes = Number(event.data);
        clearTimeout(ackStall);
        ackStall = undefined;
        for (const ack of ackWaiters.splice(0)) ack.resolve();
        return;
      }
      const chunk = new Uint8Array(event.data as ArrayBuffer);
      if (waiter !== null) {
        const pending = waiter;
        waiter = null;
        pending(chunk);
      } else {
        chunks.push(chunk);
      }
    });
    socket.addEventListener('close', event => {
      closed = { code: event.code, reason: event.reason };
      failAcks('relay closed');
      if (waiter !== null) {
        const pending = waiter;
        waiter = null;
        pending(null);
      }
    });
    socket.addEventListener('error', () => {
      if (socket.readyState !== WebSocket.OPEN) reject(new Error('relay refused the upgrade'));
    });
    socket.addEventListener('open', () =>
      resolve({
        socket,
        closed: () => closed,
        read: () =>
          new Promise(res => {
            const next = chunks.shift();
            if (next !== undefined) {
              res(next);
            } else if (closed !== null) {
              res(null);
            } else {
              waiter = res;
            }
          }),
        write: async bytes => {
          const copy = bytes.slice();
          while (sentBytes - ackedBytes >= WRITE_WINDOW_BYTES) await waitForAck();
          if (socket.readyState !== WebSocket.OPEN) throw new Error('relay closed');
          sentBytes += copy.byteLength;
          socket.send(copy.buffer);
        },
        flush: async () => {
          const target = sentBytes;
          while (ackedBytes < target) await waitForAck();
        },
      }),
    );
  });

const randomBase64Lines = (bytes: number): Uint8Array => {
  // 57 bytes make one 76-column base64 line, as an attachment's lines are.
  const line = 78;
  const out = new Uint8Array(Math.floor(bytes / line) * line);
  const seed = new Uint8Array(57);
  for (let offset = 0; offset < out.length; offset += line) {
    crypto.getRandomValues(seed);
    const text = `${btoa(String.fromCharCode(...seed))}\r\n`;
    for (let i = 0; i < line; i += 1) out[offset + i] = text.charCodeAt(i);
  }
  return out;
};

const messageOf = (address: string, sizeMib: number): Uint8Array => {
  const boundary = `b${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(
    [
      `From: ${address}`,
      `To: ${address}`,
      `Subject: yozz relay test ${sizeMib} MiB`,
      `Date: ${formatDate(Temporal.Now.zonedDateTimeISO('UTC'))}`,
      `Message-ID: <${crypto.randomUUID()}@yozz.app>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'YOZZ relay test. Safe to delete.',
      `--${boundary}`,
      'Content-Type: application/octet-stream; name="test.bin"',
      'Content-Disposition: attachment; filename="test.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      '',
    ].join('\r\n'),
  );
  const tail = new TextEncoder().encode(`--${boundary}--\r\n`);
  const body = randomBase64Lines(sizeMib * MIB - head.length - tail.length);
  const message = new Uint8Array(head.length + body.length + tail.length);
  message.set(head);
  message.set(body, head.length);
  message.set(tail, head.length + body.length);
  return message;
};

/** TLS 1.3 to `serverName` through the relay, as the browser runs it. */
const tlsOverRelay = async (relay: Relay, serverName: string): Promise<ByteDuplex> => {
  const tls = await startTls({
    transport: { read: relay.read, write: relay.write },
    serverName,
    trustAnchors: anchors.source,
    validationTime: Temporal.Now.instant(),
    validator: YOZZ_VALIDATOR,
  });
  if (!tls.ok) throw new Error(`TLS handshake: ${tls.reason.kind}`);
  return tlsDuplex(tls.connection);
};

const smtpOver = async (relay: Relay, address: string, password: string, abort: boolean) => {
  const inner = await tlsOverRelay(relay, SMTP_HOST);
  let reachedEnd: () => void = () => {};
  const bodyWritten = new Promise<void>(resolve => {
    reachedEnd = resolve;
  });
  const client = createSmtpClient({
    read: inner.read,
    flush: relay.flush,
    // The client writes the terminator on its own; an abort run keeps it back, so nothing is sent.
    write: async bytes => {
      if (abort && bytes.length === 3 && bytes[0] === 0x2e) {
        reachedEnd();
        return;
      }
      await inner.write(bytes);
    },
  });
  const greeting = await client.greeting();
  if (!greeting.ok) throw new Error(`greeting: ${JSON.stringify(greeting.reason)}`);
  const caps = await client.ehlo('yozz.app');
  if (!caps.ok) throw new Error(`EHLO: ${JSON.stringify(caps.reason)}`);
  const auth = await client.authenticate(address, password);
  if (!auth.ok) throw new Error(`auth: ${JSON.stringify(auth.reason)}`);
  return { client, bodyWritten, caps: caps.value };
};

const abortRun = async (cookie: string, address: string, password: string, sizeMib: number) => {
  const relay = await openRelay(cookie, SMTP_HOST, 465);
  try {
    const { client, bodyWritten } = await smtpOver(relay, address, password, true);
    const data = messageOf(address, sizeMib);
    const start = Date.now();
    const sending = client.send({ from: address, to: [address], data });
    const refusal = await Promise.race([
      bodyWritten.then(() => null),
      sending.then(result => (result.ok ? null : result.reason)),
      (async () => {
        while (relay.closed() === null) await sleep(200);
        return null;
      })(),
    ]);
    if (refusal?.kind === 'too-large') {
      log(
        `SKIP  ${sizeMib} MiB: refused before any upload, the host takes ${refusal.limitBytes} bytes`,
      );
      return true;
    }
    // The client flushes before its terminator, so the relay has written all of this to TCP by now.
    const uploadMs = Date.now() - start;
    const settleUntil = Date.now() + SETTLE_MS;
    while (relay.closed() === null && Date.now() < settleUntil) await sleep(200);
    const closed = relay.closed();
    const mbps = ((sizeMib * MIB * 8) / 1_000_000 / (uploadMs / 1000)).toFixed(1);
    log(
      closed === null
        ? `PASS  ${sizeMib} MiB stopped before the end: uploaded in ${uploadMs} ms (${mbps} Mbps), socket still open ${SETTLE_MS / 1000} s later`
        : `FAIL  ${sizeMib} MiB: socket closed ${closed.code} "${closed.reason}" after ${uploadMs} ms (${mbps} Mbps)`,
    );
    return closed === null;
  } finally {
    relay.socket.close();
  }
};

const fullSend = async (cookie: string, address: string, password: string, sizeMib: number) => {
  const relay = await openRelay(cookie, SMTP_HOST, 465);
  try {
    const { client, caps } = await smtpOver(relay, address, password, false);
    log(`      server capabilities: ${JSON.stringify(caps).slice(0, 200)}`);
    const start = Date.now();
    const sent = await Promise.race([
      client.send({
        from: address,
        to: [address],
        data: messageOf(address, sizeMib),
      }),
      sleep(SEND_DEADLINE_MS).then(() => {
        throw new Error(`no answer ${SEND_DEADLINE_MS / 1000} s into the ${sizeMib} MiB send`);
      }),
    ]);
    const ms = Date.now() - start;
    if (sent.ok) {
      log(
        `PASS  ${sizeMib} MiB full send accepted in ${ms} ms: ${sent.value.lines.join(' ').slice(0, 120)}`,
      );
      return true;
    }
    if (sent.reason.kind === 'too-large') {
      log(
        `SKIP  ${sizeMib} MiB: refused before any upload, the host takes ${sent.reason.limitBytes} bytes`,
      );
      return false;
    }
    log(
      `FAIL  ${sizeMib} MiB full send after ${ms} ms: ${JSON.stringify(sent.reason).slice(0, 200)} socket=${JSON.stringify(relay.closed())}`,
    );
    return false;
  } finally {
    relay.socket.close();
  }
};

const withImap = async <T>(
  address: string,
  password: string,
  run: (client: ReturnType<typeof createImapClient>) => Promise<T>,
): Promise<T> => {
  const socket: Socket = await new Promise((resolve, reject) => {
    const opened = connect({ host: IMAP_HOST, port: 993 }, () => resolve(opened));
    opened.on('error', reject);
  });
  try {
    const transport = socketTransport(socket);
    const tls = await startTls({
      transport: { read: transport.read, write: transport.write },
      serverName: IMAP_HOST,
      trustAnchors: anchors.source,
      validationTime: Temporal.Now.instant(),
      validator: YOZZ_VALIDATOR,
    });
    if (!tls.ok) throw new Error(`IMAP TLS: ${tls.reason.kind}`);
    const client = createImapClient(tlsDuplex(tls.connection));
    const greeting = await client.greeting();
    if (!greeting.ok) throw new Error('IMAP greeting');
    await client.capability();
    const auth = await client.authenticate(address, password);
    if (!auth.ok) throw new Error('IMAP auth');
    return await run(client);
  } finally {
    socket.destroy();
  }
};

/** The whole message, `BODY.PEEK[]`, read back through the relay at the limit YOZZ ships. */
const downloadThroughRelay = async (
  cookie: string,
  address: string,
  password: string,
  message: { readonly uid: number; readonly size: number },
) => {
  const relay = await openRelay(cookie, IMAP_HOST, 993);
  try {
    const client = createImapClient(await tlsOverRelay(relay, IMAP_HOST));
    const greeting = await client.greeting();
    if (!greeting.ok) throw new Error('IMAP greeting through the relay');
    const authenticated = await client.authenticate(address, password);
    if (!authenticated.ok) throw new Error('IMAP auth through the relay');
    const selected = await client.select('INBOX');
    if (!selected.ok) throw new Error('IMAP select through the relay');
    if (message.size > DEFAULT_MAX_LITERAL_BYTES) {
      log(
        `FAIL  the message is ${message.size} bytes, over the ${DEFAULT_MAX_LITERAL_BYTES} the IMAP client takes`,
      );
      return false;
    }
    const start = Date.now();
    const raw = await Promise.race([
      client.fetchRaw(message.uid),
      sleep(SEND_DEADLINE_MS).then(() => {
        throw new Error(`no whole message ${SEND_DEADLINE_MS / 1000} s into the download`);
      }),
    ]);
    const ms = Date.now() - start;
    if (!raw.ok) {
      log(
        `FAIL  download after ${ms} ms: ${JSON.stringify(raw.reason).slice(0, 200)} socket=${JSON.stringify(relay.closed())}`,
      );
      return false;
    }
    const mbps = ((raw.value.length * 8) / 1_000_000 / (ms / 1000)).toFixed(1);
    const verdict = raw.value.length === message.size ? 'PASS' : 'FAIL';
    log(
      `${verdict}  downloaded ${raw.value.length} bytes through the relay in ${ms} ms (${mbps} Mbps, unthrottled); the server's RFC822.SIZE says ${message.size}`,
    );
    return raw.value.length === message.size;
  } finally {
    relay.socket.close();
  }
};

const inboxSummaries = (address: string, password: string) =>
  withImap(address, password, async client => {
    const selected = await client.select('INBOX');
    if (!selected.ok) throw new Error('IMAP select');
    if (selected.value.exists === 0) return [];
    const summaries = await client.fetchSummaries('1:*');
    if (!summaries.ok) throw new Error('IMAP fetch');
    return summaries.value;
  });

const magicLinkIn = (address: string, password: string) =>
  withImap(address, password, async client => {
    const selected = await client.select('INBOX');
    if (!selected.ok) throw new Error('IMAP select');
    if (selected.value.exists === 0) return null;
    const summaries = await client.fetchSummaries('1:*');
    if (!summaries.ok) throw new Error('IMAP fetch');
    for (const summary of summaries.value) {
      const raw = await client.fetchRaw(summary.uid);
      if (!raw.ok) continue;
      const text = new TextDecoder()
        .decode(raw.value)
        .replace(/=\r?\n/g, '')
        .replace(/=3D/g, '=')
        .replace(/&amp;/g, '&');
      const match = text.match(/https:\/\/[^\s"'<>]*token=[^\s"'<>]+/);
      if (match !== null) return match[0];
    }
    return null;
  });

const main = async () => {
  const name = `relay-test-${crypto.randomUUID().slice(0, 8)}`;
  const address = `${name}@yozz.app`;
  const alias = await feCall<{ id: string }>('POST', FE_ALIASES, {
    name,
    has_imap: true,
    recipients: [],
  });
  const aliasId = alias.id;
  log(`created alias ${address} (id ${aliasId})`);
  let cookie: string | null = null;
  let userId: string | null = null;
  try {
    await feCall('PUT', `${FE_ALIASES}/${aliasId}`, { recipients: [], has_imap: true });
    const checked = await feCall<{ recipients?: string[] }>('GET', `${FE_ALIASES}/${aliasId}`);
    if ((checked.recipients ?? []).length !== 0) throw new Error('alias still forwards somewhere');
    const { password } = await feCall<{ password: string }>(
      'POST',
      `${FE_ALIASES}/${aliasId}/generate-password`,
      {},
    );
    // Logging in first creates the mailbox the sign-in link lands in.
    await withImap(address, password, async client => client.select('INBOX'));
    log('mailbox ready');

    const asked = await fetch(`${API}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB },
      body: JSON.stringify({ email: address, name: address, callbackURL: `${WEB}/enrol` }),
    });
    if (!asked.ok) throw new Error(`magic link request answered ${asked.status}`);
    let link: string | null = null;
    for (let attempt = 0; attempt < 30 && link === null; attempt += 1) {
      await sleep(5000);
      link = await magicLinkIn(address, password);
    }
    if (link === null) throw new Error('no sign-in link arrived in 150 s');
    const verified = await fetch(link, { redirect: 'manual', headers: { origin: WEB } });
    const cookies = verified.headers.getSetCookie().map(pair => pair.split(';')[0]);
    if (cookies.length === 0) {
      throw new Error(`sign-in link answered ${verified.status}, no cookie`);
    }
    cookie = cookies.join('; ');
    const session = await fetch(`${API}/api/auth/get-session`, {
      headers: { cookie, origin: WEB },
    }).then(response => response.json() as Promise<{ user?: { id?: string } } | null>);
    userId = session?.user?.id ?? null;
    if (userId === null) throw new Error('no session after the sign-in link');
    log('signed in to a throwaway YOZZ account');

    for (const size of ABORT_SIZES_MIB) {
      await abortRun(cookie, address, password, size);
    }
    let delivered: number | null = null;
    for (const size of FULL_SEND_SIZES_MIB) {
      if (await fullSend(cookie, address, password, size)) {
        delivered = size;
        break;
      }
    }
    if (delivered !== null) {
      const expected = delivered * MIB * 0.9;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        await sleep(5000);
        // Straight to the server: only arrival is watched here, the download below crosses the relay.
        const largest = (await inboxSummaries(address, password))
          .map(({ uid, size }) => ({ uid, size: size ?? 0 }))
          .reduce((best, candidate) => (candidate.size > best.size ? candidate : best), {
            uid: 0,
            size: 0,
          });
        if (largest.size >= expected) {
          log(`PASS  the ${delivered} MiB email arrived: ${largest.size} bytes in the mailbox`);
          await downloadThroughRelay(cookie, address, password, largest);
          break;
        }
        if (attempt === 23) {
          log(`NOTE  not in the mailbox after 120 s (largest ${largest.size} bytes)`);
        }
      }
    }
  } finally {
    if (cookie !== null && userId !== null) {
      const removed = await fetch(`${API}/api/v1/account`, {
        method: 'DELETE',
        headers: { cookie, origin: WEB, [ACCOUNT_HEADER]: userId },
      });
      log(`YOZZ account delete answered ${removed.status}`);
    } else {
      log('NOTE  no YOZZ session; if a link was requested, an account may remain');
    }
    await feRequest('DELETE', `${FE_ALIASES}/${aliasId}`);
    log('alias deleted');
  }
};

try {
  await main();
} catch (error) {
  log(`ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
process.exit();
