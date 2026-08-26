/**
 * Live SMTP harness: banner + EHLO over implicit TLS (465) against real submission hosts, through
 * @yozz.app/tls over node:net. With YOZZ_SMTP_HOST/USER/PASSWORD set it also authenticates there, and
 * with YOZZ_SMTP_TO set as well it sends one real message.
 *
 *     pnpm -F @yozz.app/smtp live                  # the matrix
 *     pnpm -F @yozz.app/smtp live smtp.gmail.com   # just the hosts named
 *
 * Run by hand only, never in CI or `pnpm test`.
 */
import { connect, type Socket } from 'node:net';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { createSmtpClient } from '../src/client.ts';
import { buildMessage } from '../src/message.ts';

export const SMTP_HOSTS: readonly string[] = [
  'smtp.gmail.com',
  'smtp.fastmail.com',
  'smtp.forwardemail.net',
  'mail.gandi.net',
  'disroot.org',
  'smtp.mailbox.org',
  'mail.riseup.net',
  'smtp.migadu.com',
  'posteo.de',
];
const SMTP_PORT = 465;
const CONNECT_TIMEOUT_MS = 15_000;

const openSocket = (host: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port: SMTP_PORT }, () => resolve(socket));
    socket.on('error', reject);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error(`no answer in ${CONNECT_TIMEOUT_MS}ms`));
    });
  });

const tlsByteDuplex = (connection: TlsConnection): ByteDuplex => ({
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

const anchors = compileAnchors(ROOT_BUNDLE);
const requested = process.argv.slice(2);
const targets = requested.length === 0 ? SMTP_HOSTS : requested;

const authHost = process.env.YOZZ_SMTP_HOST;
const authUser = process.env.YOZZ_SMTP_USER;
const authPass = process.env.YOZZ_SMTP_PASSWORD;
const sendTo = process.env.YOZZ_SMTP_TO;

let failures = 0;
const fail = (host: string, what: string) => {
  failures += 1;
  console.log(`FAIL  ${host.padEnd(22)} ${what}`);
};

for (const host of targets) {
  let socket: Socket | undefined;
  try {
    socket = await openSocket(host);
    const transport = socketTransport(socket);
    const tlsResult = await startTls({
      transport: { read: transport.read, write: transport.write },
      serverName: host,
      trustAnchors: anchors.source,
      validationTime: new Date(),
      validator: YOZZ_VALIDATOR,
    });
    if (!tlsResult.ok) {
      fail(host, `TLS handshake: ${tlsResult.reason.kind}`);
      continue;
    }
    const client = createSmtpClient(tlsByteDuplex(tlsResult.connection));

    const banner = await client.greeting();
    if (!banner.ok) {
      fail(host, `banner: ${JSON.stringify(banner.reason)}`);
      continue;
    }
    const caps = await client.ehlo('yozz.app');
    if (!caps.ok) {
      fail(host, `EHLO: ${JSON.stringify(caps.reason)}`);
      continue;
    }
    console.log(
      `ok    ${host.padEnd(22)} ${banner.value.lines[0]?.slice(0, 40)} | AUTH ${caps.value.auth.join(',') || '-'} | ${caps.value.keywords.filter(k => k !== 'AUTH').join(' ')}`,
    );

    if (host === authHost && authUser !== undefined && authPass !== undefined) {
      const auth = await client.authenticate(authUser, authPass);
      if (!auth.ok) {
        fail(host, `auth: ${JSON.stringify(auth.reason)}`);
        continue;
      }
      console.log('      auth ok');
      if (sendTo !== undefined) {
        const sent = await client.send({
          from: authUser,
          to: [sendTo],
          data: buildMessage({
            from: { address: authUser, name: 'YOZZ live harness' },
            to: [sendTo],
            subject: `yozz smtp live ${new Date().toISOString()}`,
            date: new Date(),
            messageId: `<${crypto.randomUUID()}@yozz.app>`,
            text: 'Sent by @yozz.app/smtp over @yozz.app/tls from Node.',
            html: '<p>Sent by <code>@yozz.app/smtp</code> over <code>@yozz.app/tls</code> from Node.</p>',
          }),
        });
        if (!sent.ok) {
          fail(host, `send: ${JSON.stringify(sent.reason)}`);
          continue;
        }
        console.log(`      sent: ${sent.value.lines.join(' ')}`);
      }
    }
    await client.quit();
    await tlsResult.connection.close();
  } catch (error) {
    fail(host, error instanceof Error ? error.message : String(error));
  } finally {
    socket?.destroy();
  }
}

process.exit(failures === 0 ? 0 : 1);
