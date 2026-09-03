/**
 * THROWAWAY: delete with the rest of the judge machinery after 2026-09-03.
 *
 * Wipes every folder of a judge mailbox and appends the fifteen fixtures fresh, from the ledger
 * without signing in. The app's Reset (`src/dev/judge/reset.ts`) does the same over the browser.
 *
 *   node harness/judge-reseed.ts judge-01 judge-02   # named accounts
 *   node harness/judge-reseed.ts all                 # every account in the ledger
 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { createImapClient } from '@yozz.app/imap';
import { buildMessage } from '@yozz.app/smtp';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { MINUTES_APART, seedFixtures, seedMessageId } from '../src/dev/judge/fixtures';

const IMAP_HOST = 'imap.forwardemail.net';
const LEDGER = new URL('../../../devpost.local/judge-accounts.json', import.meta.url).pathname;

type Account = { address: string; mailboxPassword: string; passphrase: string };

const open = async (account: Account) => {
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
  const auth = await client.authenticate(account.address, account.mailboxPassword);
  if (!auth.ok) throw new Error(`auth: ${JSON.stringify(auth.reason)}`);
  return { client, close: () => socket.destroy() };
};

const reseed = async (account: Account) => {
  const { client, close } = await open(account);
  try {
    const listed = await client.list('', '*');
    if (!listed.ok) throw new Error('LIST refused');
    const boxes = listed.value;
    const sent = boxes.find(b => b.attributes.includes('\\Sent'))?.name;
    if (sent === undefined) throw new Error(`no \\Sent folder among ${boxes.map(b => b.name)}`);

    // Every refusal aborts before a fixture is appended; appending onto a half-done wipe duplicates the fifteen on top of the strays.
    let wiped = 0;
    for (const box of boxes.map(b => b.name)) {
      const selected = await client.select(box);
      if (!selected.ok) throw new Error(`SELECT ${box} refused`);
      if (selected.value.exists === 0) continue;
      const all = await client.fetchSummariesBySeq(`1:${selected.value.exists}`);
      if (!all.ok) throw new Error(`FETCH ${box} refused`);
      if (all.value.length === 0) continue;
      const uids = all.value.map(m => m.uid).join(',');
      const flagged = await client.storeFlags(uids, 'add', ['\\Deleted']);
      if (!flagged.ok) throw new Error(`STORE \\Deleted in ${box} refused`);
      const expunged = await client.uidExpunge(uids);
      if (!expunged.ok) throw new Error(`UID EXPUNGE in ${box} refused`);
      wiped += all.value.length;
    }

    const fixtures = seedFixtures(account.address);
    const now = Date.now();
    let appended = 0;
    const failed: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const { slug, box, unread, ...message } = fixture;
      const date = new Date(now - (fixtures.length - index) * MINUTES_APART * 60_000);
      const raw = buildMessage({
        ...message,
        to: [account.address],
        date,
        messageId: seedMessageId(slug),
      });
      const home = box === 'sent' ? sent : 'INBOX';
      const result = await client.append(home, raw, unread === true ? [] : ['\\Seen'], date);
      if (result.ok) appended += 1;
      else failed.push(slug);
    }
    console.log(
      `${account.address}: wiped ${wiped}, appended ${appended}/${fixtures.length}` +
        (failed.length > 0 ? ` — FAILED ${failed.join(', ')}` : ''),
    );
  } finally {
    await client.logout().catch(() => {});
    close();
  }
};

const ledger: Account[] = JSON.parse(readFileSync(LEDGER, 'utf8'));
const wanted = process.argv.slice(2);
if (wanted.length === 0) throw new Error('name accounts, or "all"');
const picked =
  wanted[0] === 'all'
    ? ledger
    : ledger.filter(a => wanted.some(w => a.address.startsWith(`${w}@`)));
console.log(`reseeding ${picked.length} account(s)`);
let failures = 0;
for (const account of picked) {
  try {
    await reseed(account);
  } catch (error) {
    failures += 1;
    console.log(`${account.address}: FAILED — ${String(error)}`);
  }
}

// A long run is read through `tail`, and the exit code is the only part that cannot scroll off.
if (failures > 0) {
  console.log(`\n${failures} of ${picked.length} account(s) FAILED — rerun them by name.`);
  process.exit(1);
}
