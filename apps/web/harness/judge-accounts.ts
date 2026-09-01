/**
 * HACKATHON ONLY: delete with the rest of `src/judge/` after 2026-09-03.
 *
 * Mints a judge a working account: a Forward Email alias with its own mailbox, a vault on
 * `yozz.app`, the alias connected, the fifteen demo messages seeded.
 *
 *   pnpm with-secrets -- pnpm -F @yozz.app/web judge:accounts --count 1
 *   … --count 50            # already-finished accounts are skipped
 *   … --delete              # removes every alias in the ledger
 *
 * The ledger (`judge-accounts.local.json`, untracked) is the resume point and the credential
 * list. Each step checks whether it already happened.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { chromium, type Page } from '@playwright/test';
import { createImapClient } from '@yozz.app/imap';
import { type ByteDuplex, startTls, type TlsConnection } from '@yozz.app/tls';
import { socketTransport } from '@yozz.app/tls/harness';
import { compileAnchors, ROOT_BUNDLE, YOZZ_VALIDATOR } from '@yozz.app/x509';
import { JUDGE_DOMAIN } from '../src/judge/domain';

/** Wanted only by the alias half, so finishing minted accounts needs no 1Password open. */
const apiKey = () => {
  const key = process.env.FORWARD_EMAIL_API_KEY;
  if (key === undefined) throw new Error('need FORWARD_EMAIL_API_KEY (pnpm with-secrets -- …)');
  return key;
};

// Not an env override: the app decides which addresses get the banner.
const DOMAIN = JUDGE_DOMAIN;
const WEB = process.env.YOZZ_WEB ?? 'https://yozz.app';
const API = process.env.YOZZ_API ?? 'https://api.yozz.app';
const IMAP_HOST = 'imap.forwardemail.net';
const LEDGER = new URL('../../../judge-accounts.local.json', import.meta.url).pathname;

type Account = {
  address: string;
  /** Forward Email's own id for the alias; the address is not a usable key on its endpoints. */
  aliasId: string;
  mailboxPassword: string;
  passphrase: string;
  /** How far this account got. */
  stage: 'alias' | 'vault' | 'ready';
};

const readLedger = (): Account[] =>
  existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, 'utf8')) as Account[]) : [];
const writeLedger = (accounts: readonly Account[]) =>
  writeFileSync(LEDGER, `${JSON.stringify(accounts, null, 2)}\n`);

/** Forward Email answers a rate limit by severing the connection rather than saying 429. */
const forwardEmail = async (
  path: string,
  init: RequestInit = {},
  attempt = 1,
): Promise<unknown> => {
  const response = await fetch(`https://api.forwardemail.net${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${btoa(`${apiKey()}:`)}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  }).catch(async (error: Error) => {
    if (attempt >= 4) throw error;
    await new Promise(resolve => setTimeout(resolve, attempt * 5_000));
    return null;
  });
  if (response === null) return forwardEmail(path, init, attempt + 1);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
};

/** Readable, and long enough to be a passphrase. */
const passphrase = () => `judge-${randomBytes(9).toString('base64url')}-vault`;

const imapConnection = async (address: string, password: string) => {
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
      const result = await (tls.connection as TlsConnection).read();
      return !result.ok || result.kind === 'closed' ? null : result.bytes;
    },
    write: async bytes => {
      const result = await (tls.connection as TlsConnection).write(bytes);
      if (!result.ok) throw new Error(`TLS write: ${result.reason.kind}`);
    },
  };
  const client = createImapClient(duplex);
  const greeting = await client.greeting();
  if (!greeting.ok) throw new Error('no IMAP greeting');
  const auth = await client.authenticate(address, password);
  if (!auth.ok) throw new Error(`IMAP auth: ${JSON.stringify(auth.reason)}`);
  return { client, close: () => socket.destroy() };
};

/** The mark a new sign-in link has to beat. */
const messageCount = async (account: Account): Promise<number> => {
  const { client, close } = await imapConnection(account.address, account.mailboxPassword);
  try {
    const selected = await client.select('INBOX');
    return selected.ok ? selected.value.exists : 0;
  } finally {
    await client.logout().catch(() => {});
    close();
  }
};

/** Every previous run left a spent link in this mailbox; the newest message must postdate the request. */
const requestAndReadMagicLink = async (account: Account): Promise<string> => {
  const before = await messageCount(account);
  const requested = await fetch(`${API}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    // The Worker's CORS answers the web origin; a request with no Origin is not what it expects.
    headers: { 'Content-Type': 'application/json', Origin: WEB },
    body: JSON.stringify({
      email: account.address,
      name: account.address,
      callbackURL: `${WEB}/enrol`,
    }),
  });
  if (!requested.ok) throw new Error(`sign-in link refused: ${requested.status}`);

  // A fresh alias's first delivery is slower than a warm mailbox's.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const { client, close } = await imapConnection(account.address, account.mailboxPassword);
    try {
      const selected = await client.select('INBOX');
      if (selected.ok && selected.value.exists > before) {
        const summaries = await client.fetchSummariesBySeq(`${selected.value.exists}`);
        const uid = summaries.ok ? summaries.value[0]?.uid : undefined;
        if (uid !== undefined) {
          const body = await client.fetchRaw(uid);
          if (body.ok) {
            // Soft line breaks first, then the `=XX` escapes; dropping only the breaks leaves `3D` in the URL.
            const text = new TextDecoder()
              .decode(body.value)
              .replace(/=\r?\n/g, '')
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              );
            const link = /https:\/\/[^\s"'<>]*magic-link\/verify[^\s"'<>]*/.exec(text)?.[0];
            if (link !== undefined) {
              // The token is spent once followed, and the app's Reset never deletes it.
              const flagged = await client.storeFlags(String(uid), 'add', ['\\Deleted']);
              const expunged = flagged.ok ? await client.uidExpunge(String(uid)) : flagged;
              // A refused sweep must not fail the account, and must be said.
              if (!expunged.ok) console.log(`  WARNING: the sign-in link could not be deleted`);
              return link.replaceAll('&amp;', '&');
            }
          }
        }
      }
    } finally {
      await client.logout().catch(() => {});
      close();
    }
  }
  throw new Error(`no new sign-in link reached ${account.address} in three minutes`);
};

/** A fresh account lands on `/enrol`; one that has a vault lands on `/login`. */
const openVault = async (page: Page, account: Account) => {
  await page.goto(await requestAndReadMagicLink(account));
  await page.waitForLoadState('networkidle');
  console.log(`  magic link landed on ${page.url()}`);

  if (/\/enrol/.test(page.url())) {
    await page.fill('#enrol-password', account.passphrase);
    await page.fill('#enrol-confirm', account.passphrase);
    await page.getByRole('button', { name: 'Create vault' }).click();
  } else if (/\/login/.test(page.url())) {
    await page.fill('#login-email', account.address);
    await page.fill('#login-password', account.passphrase);
    // Two buttons say "Log in": the passkey panel's, then the password panel's.
    await page.getByRole('button', { name: 'Log in' }).last().click();
  } else {
    await page.screenshot({ path: '/tmp/judge-landing.png' });
    throw new Error(`magic link went to ${page.url()} (screenshot in /tmp/judge-landing.png)`);
  }
  // Deriving the key is slow, and the redirect only happens once it is done.
  await page.waitForURL(/\/(settings|m\/|connect)/, { timeout: 120_000 });
};

const connectAddress = async (page: Page, account: Account) => {
  // Navigated to from inside the app: a full page load lands on /login with the vault shut.
  await page.getByRole('link', { name: 'Settings' }).click();
  // Already there from a run that died before writing the ledger; adding again is refused as a duplicate.
  if (await page.getByText(account.address, { exact: true }).first().isVisible()) {
    console.log(`  ${account.address} is already connected`);
    return;
  }
  await page.getByRole('link', { name: 'Add an address' }).click();
  await page.waitForSelector('#connect-address', { timeout: 30_000 });
  await page.fill('#connect-address', account.address);
  await page.fill('#connect-username', account.address);
  await page.fill('#connect-password', account.mailboxPassword);
  await page.getByRole('button', { name: 'Add address' }).click();
  await page.waitForURL(/\/(m|settings)/, { timeout: 120_000 });
};

const seed = async (page: Page) => {
  const reset = page.getByRole('button', { name: 'Reset inbox' });
  await reset.waitFor({ timeout: 30_000 });
  await reset.click();
  await page.getByText(/Inbox reset/).waitFor({ timeout: 180_000 });
};

/** The alias half: the only part that needs the Forward Email key. */
const mint = async (index: number, accounts: Account[], aliasesOnly = false) => {
  const name = `judge-${String(index).padStart(2, '0')}`;
  const address = `${name}@${DOMAIN}`;
  let account = accounts.find(candidate => candidate.address === address);

  if (account === undefined) {
    // `has_imap` is what gives the alias a mailbox; without it mail is forwarded and lost.
    const created = (await forwardEmail(`/v1/domains/${DOMAIN}/aliases`, {
      method: 'POST',
      // Caps what a stranger with the credentials could park in the account's pooled 10 GB.
      body: JSON.stringify({
        name,
        has_imap: true,
        is_enabled: true,
        // CREATE ignores an empty recipients list and the alias inherits the account's sink; naming
        // itself is refused as recursive, so it is set again below.
        recipients: [],
        // The alias's own cap. The domain's `max_quota_per_alias` is the domain's total quota.
        max_quota: '5MB',
        description: 'WebMCP judge',
      }),
    }).catch(async (error: Error) => {
      // Left behind by an interrupted run: its id is the only handle the other endpoints take.
      if (!/already exists/i.test(error.message)) throw error;
      const listed = (await forwardEmail(`/v1/domains/${DOMAIN}/aliases`)) as {
        name: string;
        id: string;
      }[];
      return listed.find(alias => alias.name === name);
    })) as { id?: string } | undefined;
    const aliasId = created?.id;
    if (aliasId === undefined) throw new Error(`no alias id came back for ${address}`);
    // The half of "stores, forwards nowhere" that only an update will do.
    await forwardEmail(`/v1/domains/${DOMAIN}/aliases/${aliasId}`, {
      method: 'PUT',
      body: JSON.stringify({ recipients: [] }),
    });
    const credentials = (await forwardEmail(
      `/v1/domains/${DOMAIN}/aliases/${aliasId}/generate-password`,
      { method: 'POST', body: JSON.stringify({}) },
    )) as { password?: string };
    if (credentials.password === undefined) throw new Error(`no password came back for ${address}`);
    account = {
      address,
      aliasId,
      mailboxPassword: credentials.password,
      passphrase: passphrase(),
      stage: 'alias',
    };
    accounts.push(account);
    writeLedger(accounts);
    console.log(`✓ ${address}: alias + mailbox`);
  }

  if (aliasesOnly || account.stage === 'ready') {
    if (!aliasesOnly) console.log(`· ${address}: already done`);
    return;
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    if (account.stage === 'alias') {
      await openVault(page, account);
      await connectAddress(page, account);
      account.stage = 'vault';
      writeLedger(accounts);
      console.log(`✓ ${address}: vault open, mailbox connected`);
    }
    await seed(page);
    account.stage = 'ready';
    writeLedger(accounts);
    console.log(`✓ ${address}: seeded`);
  } finally {
    await browser.close();
  }
};

const args = process.argv.slice(2);
const countOf = (flag: string, fallback: number) => {
  const at = args.indexOf(flag);
  return at === -1 ? fallback : Number(args[at + 1]);
};

const accounts = readLedger();
if (args.includes('--delete')) {
  const left: Account[] = [];
  for (const account of accounts) {
    const gone = await forwardEmail(`/v1/domains/${DOMAIN}/aliases/${account.aliasId}`, {
      method: 'DELETE',
    })
      .then(() => true)
      .catch((error: Error) => {
        console.log(`  could not delete ${account.address}: ${error.message}`);
        return false;
      });
    if (gone) console.log(`✓ deleted ${account.address}`);
    // Kept: the ledger is the only record this mailbox exists.
    else left.push(account);
  }
  writeLedger(left);
  if (left.length > 0)
    console.log(`\n${left.length} alias(es) survived; the ledger still has them`);
} else {
  const start = countOf('--start', 1);
  const count = countOf('--count', 1);
  for (let index = start; index < start + count; index += 1) {
    // One at a time: Forward Email severs the connection on a rate limit.
    await mint(index, accounts, args.includes('--aliases-only'));
    // Paced, for the same reason.
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  console.log(`\n${accounts.filter(a => a.stage === 'ready').length} accounts ready in ${LEDGER}`);
}
