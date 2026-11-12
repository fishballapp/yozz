import { connect, type Socket } from 'node:net';
import { type ByteDuplex, startTls, type TlsConnection, type TlsFailure } from '@yozz.app/tls';
import { endGracefully, HOSTS, IMAP_PORT, socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { createImapClient, type ImapMessageSummary } from '../src/client.ts';
import type { UidSearchCriterion } from '../src/commands.ts';

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

type LiveClient = ReturnType<typeof createImapClient>;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The day of an INTERNALDATE such as `23-Aug-2026 09:00:00 +0000`. */
const dayOf = (internalDate: string | null): Temporal.PlainDate | null => {
  const [, day, month, year] =
    /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/u.exec(internalDate ?? '') ?? [];
  const index = MONTH_NAMES.indexOf(month ?? '');
  return day === undefined || year === undefined || index < 0
    ? null
    : Temporal.PlainDate.from({ year: Number(year), month: index + 1, day: Number(day) });
};

/**
 * Read-only: whether one `UID SEARCH` of several keys answers the uids its keys answer apart,
 * intersected, which is what yozz's folded search commands rely on. The keys come from the last
 * messages fetched, so the selected folder needs mail in it.
 */
const checkAndOfKeys = async (
  client: LiveClient,
  messages: readonly ImapMessageSummary[],
): Promise<{ readonly text: string; readonly failed: number }> => {
  const sender = messages.flatMap(({ envelope }) => envelope?.from[0]?.mailbox ?? []).at(0);
  const word = messages
    .flatMap(({ envelope }) => envelope?.subject?.split(/\s+/u) ?? [])
    .find(candidate => /^[a-z]{4,}$/iu.test(candidate));
  if (sender === undefined || word === undefined) {
    return {
      text: 'AND of keys: skipped, the last messages name no sender and subject word to search for',
      failed: 0,
    };
  }
  const days = messages.flatMap(({ internalDate }) => dayOf(internalDate) ?? []);
  const since = days.at(Math.floor(days.length / 2));
  const from = { key: 'FROM', value: sender } as const;
  const subject = { key: 'SUBJECT', value: word } as const;
  const commands: readonly (readonly UidSearchCriterion[])[] = [
    [{ key: 'UNSEEN' }, from],
    [{ key: 'FLAGGED' }, from],
    [from, subject],
    [from, { key: 'TEXT', value: word }],
    [{ key: 'HEADER', header: 'Reply-To', value: sender }, subject],
    ...(since === undefined
      ? []
      : [
          [{ key: 'UNSEEN' }, { key: 'SINCE', date: since }, from] as const,
          [{ key: 'SINCE', date: since }, subject] as const,
        ]),
  ];
  const verdicts = await Promise.all(
    commands.map(async keys => {
      const name = keys.map(({ key }) => key).join(' ');
      const together = await client.uidSearch(keys);
      const apart = await Promise.all(keys.map(key => client.uidSearch(key)));
      const parts = apart.flatMap(answer => (answer.ok ? [answer.value] : []));
      if (!together.ok || parts.length !== keys.length) return `REFUSED  ${name}`;
      const expected = parts.reduce((left, right) => left.filter(uid => right.includes(uid)));
      const isSame =
        together.value.length === expected.length &&
        together.value.every(uid => expected.includes(uid));
      return `${isSame ? 'ok      ' : 'MISMATCH'} ${name}: ${together.value.length} found, ${expected.length} expected`;
    }),
  );
  return {
    text: `AND of keys, read-only:\n        ${verdicts.join('\n        ')}`,
    failed: verdicts.filter(verdict => !verdict.startsWith('ok')).length,
  };
};

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
      validationTime: Temporal.Now.instant(),
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
    const literalSupport = (() => {
      if (upperCaps.includes('LITERAL+')) return 'LITERAL+';
      if (upperCaps.includes('LITERAL-')) return 'LITERAL-';
      return '-';
    })();
    const saslIrSupport = upperCaps.includes('SASL-IR') ? 'SASL-IR' : '-';
    const authMechs = upperCaps
      .filter(c => c.startsWith('AUTH='))
      .map(c => c.slice(5))
      .join(',');

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

      const andOfKeys = await checkAndOfKeys(client, summariesRes.value);
      failures += andOfKeys.failed;
      console.log(`      ${andOfKeys.text}`);

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
