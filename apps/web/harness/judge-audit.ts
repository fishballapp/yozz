/** Throwaway: list every INBOX message in a few judge mailboxes, to find strays a reset cannot remove. */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createImapClient } from '@yozz.app/imap';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';

const IMAP_HOST = 'imap.forwardemail.net';
const LEDGER = new URL('../../../devpost.local/judge-accounts.json', import.meta.url).pathname;

const open = async (address: string, password: string) => {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const opened = connect({ host: IMAP_HOST, port: 993 }, () => resolve(opened));
    opened.on('error', reject);
  });
  const transport = socketTransport(socket);
  const tls = await startTls({
    transport: { read: transport.read, write: transport.write },
    serverName: IMAP_HOST,
    trustAnchors: compileAnchors(ROOT_BUNDLE).source,
    validationTime: new Date(),
    validator: YOZZ_VALIDATOR,
  });
  if (!tls.ok) throw new Error(`TLS: ${tls.reason.kind}`);
  const duplex: ByteDuplex = {
    read: async () => {
      const r = await (tls.connection as TlsConnection).read();
      return !r.ok || r.kind === 'closed' ? null : r.bytes;
    },
    write: async bytes => {
      const r = await (tls.connection as TlsConnection).write(bytes);
      if (!r.ok) throw new Error(`TLS write: ${r.reason.kind}`);
    },
  };
  const client = createImapClient(duplex);
  if (!(await client.greeting()).ok) throw new Error('no greeting');
  const auth = await client.authenticate(address, password);
  if (!auth.ok) throw new Error(`auth: ${JSON.stringify(auth.reason)}`);
  return { client, close: () => socket.destroy() };
};

const ledger: { address: string; mailboxPassword: string }[] = JSON.parse(
  readFileSync(LEDGER, 'utf8'),
);
const wanted = process.argv.slice(2);
const picked =
  wanted[0] === 'all'
    ? ledger
    : ledger.filter(a => wanted.some(w => a.address.startsWith(`judge-${w}@`)));

for (const account of picked) {
  const { client, close } = await open(account.address, account.mailboxPassword);
  try {
    const boxes = await client.list('', '*');
    const names = boxes.ok ? boxes.value.map(b => b.name) : ['INBOX'];
    console.log(`\n=== ${account.address} ===`);
    for (const box of names) {
      const selected = await client.select(box);
      const exists = selected.ok ? selected.value.exists : 0;
      if (exists === 0) continue;
      const summaries = await client.fetchSummariesBySeq(`1:${exists}`);
      if (!summaries.ok) {
        console.log(`  ${box}: fetch failed`);
        continue;
      }
      const strays = summaries.value.filter(
        m => !(m.envelope?.messageId ?? '').startsWith('<yozz-seed-'),
      );
      const unread = summaries.value.filter(m => !m.flags.includes('\\Seen')).length;
      console.log(`  ${box}: ${exists} message(s), ${unread} unread, ${strays.length} NOT a seed`);
      for (const m of strays) {
        const from = m.envelope?.from[0];
        console.log(
          `    ! [${m.uid}] ${from?.mailbox ?? '?'}@${from?.host ?? '?'} :: ${m.envelope?.subject ?? '(no subject)'}  [${m.envelope?.date ?? '?'}]`,
        );
      }
    }
  } finally {
    await client.logout().catch(() => {});
    close();
  }
}
