/**
 * HACKATHON ONLY — delete with the rest of the judge machinery after 2026-09-03.
 *
 * What a judge's mailbox actually holds, straight off the server: every folder with mail in it and
 * every subject in the inbox. The one way to tell "provisioned" from "the ledger says provisioned",
 * and the tool that found the domain-quota failure, where mail was accepted and silently dropped.
 *
 *   node harness/probe.ts judge-05@webmcp-judge.yozz.app
 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createImapClient } from '@yozz.app/imap';
import { type ByteDuplex, startTls } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';

const wanted = process.argv[2] ?? 'judge-02@webmcp-judge.yozz.app';
const ledger = JSON.parse(
  readFileSync(new URL('../../../judge-accounts.local.json', import.meta.url).pathname, 'utf8'),
) as { address: string; mailboxPassword: string }[];
const account = ledger.find(a => a.address === wanted);
if (account === undefined) throw new Error(`no ${wanted} in the ledger`);

const socket = await new Promise<Socket>((resolve, reject) => {
  const opened = connect({ host: 'imap.forwardemail.net', port: 993 }, () => resolve(opened));
  opened.on('error', reject);
});
const transport = socketTransport(socket);
const tls = await startTls({
  transport: { read: transport.read, write: transport.write },
  serverName: 'imap.forwardemail.net',
  trustAnchors: compileAnchors(ROOT_BUNDLE).source,
  validationTime: new Date(),
  validator: YOZZ_VALIDATOR,
});
if (!tls.ok) throw new Error(`TLS: ${tls.reason.kind}`);
const duplex: ByteDuplex = {
  read: async () => {
    const r = await tls.connection.read();
    return !r.ok || r.kind === 'closed' ? null : r.bytes;
  },
  write: async bytes => {
    const r = await tls.connection.write(bytes);
    if (!r.ok) throw new Error('write');
  },
};
const client = createImapClient(duplex);
console.log('greeting', (await client.greeting()).ok);
console.log(
  'auth',
  JSON.stringify(await client.authenticate(account.address, account.mailboxPassword)).slice(0, 200),
);
const boxes = await client.list('', '*');
if (boxes.ok)
  for (const box of boxes.value) {
    const opened = await client.select(box.name);
    if (opened.ok && opened.value.exists > 0) console.log(`  ${box.name}: ${opened.value.exists}`);
  }
const selected = await client.select('INBOX');
console.log(
  'INBOX',
  selected.ok ? `exists=${selected.value.exists}` : JSON.stringify(selected.reason),
);
if (selected.ok && selected.value.exists > 0) {
  const summaries = await client.fetchSummariesBySeq(`1:${selected.value.exists}`);
  if (summaries.ok)
    for (const message of summaries.value) console.log(' -', message.envelope?.subject);
}
await client.logout();
socket.destroy();
