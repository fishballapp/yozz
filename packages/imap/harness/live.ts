/**
 * Live IMAP harness: speaks real IMAP to the nine mail servers via @yozz.app/tls.
 *
 *     pnpm -F @yozz.app/imap live            # all nine
 *     pnpm -F @yozz.app/imap live posteo.de  # just the hosts named
 *
 * Run by hand only, never in CI or `pnpm test`.
 */

import { connect, type Socket } from 'node:net';
import { type ByteDuplex, startTls, type TlsConnection, type TlsFailure } from '@yozz.app/tls';
import { endGracefully, HOSTS, IMAP_PORT, socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { createImapClient } from '../src/client.ts';

const describeFailure = (failure: TlsFailure): string => {
  switch (failure.kind) {
    case 'alert-sent':
      return `we sent ${failure.alert.description}`;
    case 'alert-received':
      return `server sent ${failure.alert.description}`;
    case 'alert-received-unknown':
      return `server sent unknown alert ${failure.code}`;
    case 'truncated':
      return 'connection truncated';
    case 'certificate':
      return `certificate ${failure.reason.code} (${failure.alert.description}, chain=${failure.chain})`;
  }
};

const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  const code = 'code' in error ? error.code : undefined;
  return code === undefined ? error.name : String(code);
};

const CONNECT_TIMEOUT_MS = 15_000;

const openSocket = (host: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host, port: IMAP_PORT }, () => resolve(socket));
    socket.on('error', reject);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error(`no answer in ${CONNECT_TIMEOUT_MS}ms`));
    });
  });

const tlsByteDuplex = (connection: TlsConnection): ByteDuplex => ({
  read: async () => {
    const result = await connection.read();
    if (!result.ok) {
      console.error(`TLS read error: ${describeFailure(result.reason)}`);
      return null;
    }
    if (result.kind === 'closed') return null;
    return result.bytes;
  },
  write: async bytes => {
    const result = await connection.write(bytes);
    if (!result.ok) {
      throw new Error(`TLS write error: ${describeFailure(result.reason)}`);
    }
  },
});

const anchors = compileAnchors(ROOT_BUNDLE);
const requested = process.argv.slice(2);
const targets = requested.length === 0 ? HOSTS : requested;

const authHost = process.env.YOZZ_IMAP_HOST;
const authUser = process.env.YOZZ_IMAP_USER;
const authPass = process.env.YOZZ_IMAP_PASSWORD;
const isAuthSession =
  authHost !== undefined && authUser !== undefined && authPass !== undefined && authHost.length > 0;

let failures = 0;

for (const host of targets) {
  let socket: Socket | undefined;
  try {
    socket = await openSocket(host);
    const transport = socketTransport(socket);

    const tlsResult = await startTls({
      transport: {
        read: transport.read,
        write: transport.write,
      },
      serverName: host,
      trustAnchors: anchors.source,
      validationTime: new Date(),
      validator: YOZZ_VALIDATOR,
    });

    if (!tlsResult.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} TLS handshake: ${describeFailure(tlsResult.reason)}`);
      continue;
    }

    const duplex = tlsByteDuplex(tlsResult.connection);
    const client = createImapClient(duplex);

    const greetingRes = await client.greeting();
    if (!greetingRes.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} greeting: ${greetingRes.reason.kind}`);
      await tlsResult.connection.close();
      continue;
    }

    const capRes = await client.capability();
    if (!capRes.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} capability: ${capRes.reason.kind}`);
      await tlsResult.connection.close();
      continue;
    }

    const upperCaps = capRes.value.map(c => c.toUpperCase());
    const literalSupport = upperCaps.includes('LITERAL+')
      ? 'LITERAL+'
      : upperCaps.includes('LITERAL-')
        ? 'LITERAL-'
        : '-';
    const saslIrSupport = upperCaps.includes('SASL-IR') ? 'SASL-IR' : '-';
    const authMechs = upperCaps
      .filter(c => c.startsWith('AUTH='))
      .map(c => c.slice(5))
      .join(',');

    // If authenticated session requested for this host
    if (isAuthSession && host === authHost) {
      console.log(`      Authenticating as ${authUser}...`);
      const authRes = await client.authenticate(authUser, authPass);
      if (!authRes.ok) {
        failures += 1;
        console.log(`FAIL  ${host.padEnd(22)} auth: ${authRes.reason.kind}`);
        await client.logout();
        await tlsResult.connection.close();
        continue;
      }

      console.log('      Auth ok. Listing mailboxes...');
      const listRes = await client.list('', '*');
      if (!listRes.ok) {
        failures += 1;
        console.log(`FAIL  ${host.padEnd(22)} list: ${listRes.reason.kind}`);
        await client.logout();
        await tlsResult.connection.close();
        continue;
      }
      console.log(`      Found ${listRes.value.length} mailboxes`);

      const selectRes = await client.select('INBOX');
      if (!selectRes.ok) {
        failures += 1;
        console.log(`FAIL  ${host.padEnd(22)} select: ${selectRes.reason.kind}`);
        await client.logout();
        await tlsResult.connection.close();
        continue;
      }

      const selected = selectRes.value;
      const hasWildcard = selected.permanentFlags.includes('\\*');
      console.log(
        `      INBOX selected: ${selected.exists} messages, PERMANENTFLAGS=(${selected.permanentFlags.join(' ')}), hasWildcard=${hasWildcard}`,
      );

      const uidNext = selected.uidNext ?? selected.exists + 1;
      const startUid = Math.max(1, uidNext - 10);
      const summariesRes = await client.fetchSummaries(`${startUid}:*`);
      if (!summariesRes.ok) {
        failures += 1;
        console.log(`FAIL  ${host.padEnd(22)} fetch: ${summariesRes.reason.kind}`);
        await client.logout();
        await tlsResult.connection.close();
        continue;
      }

      console.log(`      Last ${summariesRes.value.length} messages:`);
      for (const msg of summariesRes.value) {
        const fromStr = msg.envelope?.from[0]?.mailbox
          ? `${msg.envelope.from[0].mailbox}@${msg.envelope.from[0].host}`
          : 'unknown';
        console.log(
          `        [UID ${msg.uid}] ${msg.internalDate ?? msg.envelope?.date ?? 'no date'} | from: ${fromStr} | ${msg.envelope?.subject ?? '(no subject)'}`,
        );
      }
    }

    const idleNote = await (async (): Promise<string> => {
      if (!client.hasCapability('IDLE')) return '';
      const idle = client.idle();
      await new Promise<void>(resolve => setTimeout(resolve, 2000));
      const idleRes = await idle.done();
      return idleRes.ok
        ? ' idle ok'
        : ` idle: ${idleRes.reason.kind === 'no' || idleRes.reason.kind === 'bad' || idleRes.reason.kind === 'bye' ? idleRes.reason.text : idleRes.reason.kind}`;
    })();

    const logoutRes = await client.logout();
    if (!logoutRes.ok) {
      failures += 1;
      console.log(`FAIL  ${host.padEnd(22)} logout: ${logoutRes.reason.kind}`);
      await tlsResult.connection.close();
      continue;
    }

    console.log(
      `ok    ${host.padEnd(22)} ${String(capRes.value.length).padStart(2)} capabilities  ${literalSupport.padEnd(8)}  ${saslIrSupport.padEnd(7)}  AUTH=${authMechs || '(none)'}${idleNote}`,
    );

    await tlsResult.connection.close();
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${host.padEnd(22)} ${errorText(error)}`);
  } finally {
    if (socket !== undefined) await endGracefully(socket);
  }
}

console.log(`\n${targets.length - failures}/${targets.length} hosts`);
process.exit(failures === 0 ? 0 : 1);
