/**
 * HACKATHON ONLY: dies with the judge machinery on 2026-09-03 because it runs off the ledger.
 * The only check on whether the server can find what we ask it to find (it caught `SEARCH
 * HEADER X-Yozz-Draft` answering empty on Forward Email). Reseed the account afterwards.
 *
 *   node harness/draft-mirror-probe.ts judge-49
 */
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { chromium } from '@playwright/test';
import { createImapClient } from '@yozz.app/imap';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';

const IMAP_HOST = 'imap.forwardemail.net';
const LEDGER = new URL('../../../devpost.local/judge-accounts.json', import.meta.url).pathname;
const who = process.argv[2] ?? 'judge-51';
const account = JSON.parse(readFileSync(LEDGER, 'utf8')).find((a: { address: string }) =>
  a.address.startsWith(`${who}@`),
);

const imap = async () => {
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

const drafts = async (label: string) => {
  const { client, close } = await imap();
  try {
    console.log(`  [CAPABILITY] UIDPLUS=${client.hasCapability('UIDPLUS')}`);
    const selected = await client.select('Drafts');
    const n = selected.ok ? selected.value.exists : 0;
    console.log(`  ${label}: Drafts holds ${n}`);
    if (n > 0) {
      const all = await client.fetchSummariesBySeq(`1:${n}`);
      if (all.ok)
        for (const m of all.value) {
          const raw = await client.fetchRaw(m.uid);
          const header = raw.ok
            ? /^X-Yozz-Draft:.*$/im.exec(new TextDecoder().decode(raw.value))?.[0]
            : undefined;
          console.log(`     [${m.uid}] "${m.envelope?.subject}"  ${header ?? 'NO X-Yozz-Draft'}`);
        }
    }
    return n;
  } finally {
    await client.logout().catch(() => {});
    close();
  }
};

console.log(`probing ${account.address}`);
await drafts('before');

const browser = await chromium.launch();
const page = await browser.newPage();
let phase = 'startup';
page.on('console', m => {
  if (m.type() === 'error') console.log(`  [${phase}] browser error: ${m.text()}`);
});
page.on('response', res => {
  const url = res.url();
  if (url.includes('/api/v1/vault/records/') || url.includes('/api/v1/relay')) {
    const tail = url.slice(url.indexOf('/api/v1/'));
    console.log(`  [${phase}] ${res.request().method()} ${res.status()} ${tail.slice(0, 90)}`);
  }
});
try {
  await page.goto('https://yozz.app/login');
  await page.fill('#login-email', account.address);
  await page.fill('#login-password', account.passphrase);
  await page.getByRole('button', { name: 'Log in' }).last().click();
  await page.waitForURL(/\/(m\/|settings|connect)/, { timeout: 120_000 });
  await page.waitForFunction(() => !document.body.innerText.includes('SYNCING'), undefined, {
    timeout: 180_000,
  });

  phase = 'compose';
  await page.getByRole('link', { name: 'Compose' }).click();
  await page.fill('#compose-to', 'mirror-probe@example.com');
  await page.fill('#compose-subject', `mirror probe ${new Date().toISOString()}`);
  await page.getByLabel('Message body, markdown').fill('does the mirror go away');
  // The mirror is written on a 10s timer after the last edit.
  await page.waitForTimeout(20_000);
  const appeared = await drafts('after typing');

  // A second edit burst: each version used to APPEND beside the last.
  phase = 'edit again';
  await page.getByLabel('Message body, markdown').fill('a second version of the body');
  await page.waitForTimeout(20_000);
  const afterEdit = await drafts('after a second version');

  phase = 'DISCARD';

  // The composer's footer, not the header X, which closes and keeps the draft.
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard' }).click();
  await page.waitForTimeout(20_000);
  const left = await drafts('after discard');

  console.log(
    afterEdit > 1 ? `FAIL: a second version left ${afterEdit} copies` : 'PASS: one copy per draft',
  );
  console.log(
    appeared === 0
      ? 'INCONCLUSIVE: no mirror was ever written'
      : left === 0
        ? 'PASS: the mirror went'
        : `FAIL: ${left} copy/copies survived the discard`,
  );
} finally {
  await browser.close();
}
