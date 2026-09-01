/**
 * HACKATHON ONLY — delete with the rest of `src/judge/` after 2026-09-03.
 *
 * Mints a judge a whole working YOZZ account: a Forward Email alias with its own mailbox, a vault
 * enrolled on `yozz.app`, that alias connected inside it, and the fifteen demo messages seeded.
 * One address each, so no judge can spoil another's inbox.
 *
 *   pnpm with-secrets -- pnpm -F @yozz.app/web judge:accounts --count 1
 *   … --count 50            # the rest; already-finished accounts are skipped
 *   … --delete              # removes every alias in the ledger, after judging
 *
 * The ledger (`judge-accounts.local.json`, untracked) is the resume point AND the credential list:
 * every address, mailbox password and vault passphrase lands there and nowhere else. Re-running is
 * safe — each step checks whether it already happened.
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

/**
 * Wanted only by the alias half. The vault half runs off the ledger, so a run that is finishing
 * accounts already minted must not need 1Password open — which is the run most likely to happen
 * hours later, unattended.
 */
const apiKey = () => {
  const key = process.env.FORWARD_EMAIL_API_KEY;
  if (key === undefined) throw new Error('need FORWARD_EMAIL_API_KEY (pnpm with-secrets -- …)');
  return key;
};

// Not an env override: the app decides which addresses get the banner (and so the Reset the last
// step clicks), so a second opinion here would mint mailboxes the SPA never offers to seed.
const DOMAIN = JUDGE_DOMAIN;
const WEB = process.env.YOZZ_WEB ?? 'https://yozz.app';
const API = process.env.YOZZ_API ?? 'https://api.yozz.app';
const IMAP_HOST = 'imap.forwardemail.net';
const LEDGER = new URL('../../../judge-accounts.local.json', import.meta.url).pathname;

type Account = {
  address: string;
  /** Forward Email's own id for the alias. The address is NOT a usable key on its endpoints. */
  aliasId: string;
  mailboxPassword: string;
  passphrase: string;
  /** How far this account got, so a re-run picks up where it stopped. */
  stage: 'alias' | 'vault' | 'ready';
};

const readLedger = (): Account[] =>
  existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, 'utf8')) as Account[]) : [];
const writeLedger = (accounts: readonly Account[]) =>
  writeFileSync(LEDGER, `${JSON.stringify(accounts, null, 2)}\n`);

/**
 * Forward Email answers a rate limit by severing the connection rather than saying 429, and a bare
 * network blip looks identical. Both are worth another go; a 4xx that actually arrived is not.
 */
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

/** Readable, and long enough that it is a passphrase rather than a password. */
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

/** How many messages the mailbox holds right now — the mark a new sign-in link has to beat. */
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

/**
 * Ask for a sign-in link and read the one that arrives, never an earlier one.
 *
 * The mark matters: every previous run left its own link in this mailbox, and those tokens are
 * spent. Taking the newest message without checking it is newer than the request answers
 * `INVALID_TOKEN` on the second run and looks like a broken vault.
 */
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

  // Three minutes: a fresh alias's first delivery is slower than a warm mailbox's, and a judge
  // account half-made costs more than the wait.
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
            // Quoted-printable, decoded properly: soft line breaks first, then the `=XX` escapes.
            // Dropping only the line breaks leaves every `=` in the URL as a literal `3D`, which
            // makes a token that looks right and is not.
            const text = new TextDecoder()
              .decode(body.value)
              .replace(/=\r?\n/g, '')
              .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              );
            const link = /https:\/\/[^\s"'<>]*magic-link\/verify[^\s"'<>]*/.exec(text)?.[0];
            if (link !== undefined) {
              // Delete it now. The token is spent the moment the browser follows it, and the app's
              // Reset never deletes, so a link left here is a message the judge sees on their
              // first sign-in and cannot clear. Fifty-one of them had to be swept by hand once.
              const flagged = await client.storeFlags(String(uid), 'add', ['\\Deleted']);
              const expunged = flagged.ok ? await client.uidExpunge(String(uid)) : flagged;
              // Enrolment does not depend on the sweep, so a refusal must not fail the account.
              // It must be SAID, though: silence here is how fifty-one strays went unnoticed.
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

/**
 * Enrol the vault, or unlock one a previous run already made. The magic link decides which: a
 * fresh account lands on `/enrol`, and one that has a vault lands on `/login` instead. A re-run
 * after any later step failed therefore takes the second path, and must not be a dead end.
 */
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
    // Two buttons say "Log in": the passkey panel's, then the password panel's. The password one
    // is second because the page offers passkeys first.
    await page.getByRole('button', { name: 'Log in' }).last().click();
  } else {
    await page.screenshot({ path: '/tmp/judge-landing.png' });
    throw new Error(`magic link went to ${page.url()} (screenshot in /tmp/judge-landing.png)`);
  }
  // Deriving the key is deliberately slow, and the redirect only happens once it is done.
  await page.waitForURL(/\/(settings|m\/|connect)/, { timeout: 120_000 });
};

const connectAddress = async (page: Page, account: Account) => {
  // Navigated to from inside the app, never by loading the URL: an unlock lives in memory unless
  // the person asked to keep it, so a full page load lands on /login with the vault shut again.
  await page.getByRole('link', { name: 'Settings' }).click();
  // Already there, because a previous run added it and died before writing the ledger. Adding it
  // again is refused as a duplicate, and the wait for a navigation that never comes cost two
  // minutes per account.
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

/**
 * The alias half: the only part that needs the Forward Email key, so it can be run for every judge
 * up front and the slow browser half finished later without a secret in reach.
 */
const mint = async (index: number, accounts: Account[], aliasesOnly = false) => {
  const name = `judge-${String(index).padStart(2, '0')}`;
  const address = `${name}@${DOMAIN}`;
  let account = accounts.find(candidate => candidate.address === address);

  if (account === undefined) {
    // `has_imap` is what gives the alias a mailbox at all; without it mail is forwarded and lost.
    const created = (await forwardEmail(`/v1/domains/${DOMAIN}/aliases`, {
      method: 'POST',
      // 5 MB is far more than fifteen fixtures and a judge's test sends, and it caps what a
      // stranger with the credentials could park in the 10 GB the account pools across every domain.
      body: JSON.stringify({
        name,
        has_imap: true,
        is_enabled: true,
        // Asked for here and then set again below, because CREATE ignores an empty recipients
        // list and the alias comes up inheriting the account's sink — which would copy every
        // judge's mail into Jason's mailbox. Naming itself instead is refused as recursive.
        recipients: [],
        // The ALIAS's own cap. Never set the domain's `max_quota_per_alias` to this: that field is
        // the domain's TOTAL quota, and an empty mailbox already costs ~480 KB, so fifty of them
        // silently stop receiving mail the moment their floors add up past it.
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
    // Kept in the ledger, because the ledger is the only record that this mailbox exists: emptying
    // it after a failed DELETE strands a live judge mailbox with credentials nobody holds.
    else left.push(account);
  }
  writeLedger(left);
  if (left.length > 0)
    console.log(`\n${left.length} alias(es) survived; the ledger still has them`);
} else {
  const start = countOf('--start', 1);
  const count = countOf('--count', 1);
  for (let index = start; index < start + count; index += 1) {
    // One at a time: Forward Email answers a rate limit by severing the connection, and a judge
    // account half-made is worse than a slow script.
    await mint(index, accounts, args.includes('--aliases-only'));
    // Paced, for the same reason the retry exists: fifty creations back to back is what their rate
    // limiter is there to stop.
    await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  console.log(`\n${accounts.filter(a => a.stage === 'ready').length} accounts ready in ${LEDGER}`);
}
