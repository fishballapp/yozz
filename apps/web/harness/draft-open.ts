/**
 * Open a vault draft in the composer in a real browser and read what the fields hold. Nothing
 * in the unit tests renders the composer. Needs both dev servers up.
 *
 *   pnpm -F @yozz.app/web draft:drive
 */
import { execFileSync } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';

type UnlockModule = typeof import('../src/vault/unlock');
type AuthModule = typeof import('../src/vault/auth-client');
type KeysModule = typeof import('../src/vault/unlock-keys');
type DraftsModule = typeof import('../src/compose/draft-vault');
const UNLOCK = '/src/vault/unlock.ts' as string;
const AUTH = '/src/vault/auth-client.ts' as string;
const KEYS = '/src/vault/unlock-keys.ts' as string;
const DRAFTS = '/src/compose/draft-vault.ts' as string;

const WEB = process.env.YOZZ_WEB ?? 'http://localhost:5177';
const API = process.env.YOZZ_API ?? 'http://localhost:8177';
const ADDRESS = 'me@example.com';

const latestMagicLink = (): string => {
  const out = execFileSync(
    'pnpm',
    [
      '-F',
      '@yozz.app/worker-api',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'yozz',
      '--local',
      '--json',
      '--command',
      'SELECT identifier FROM verification ORDER BY createdAt DESC LIMIT 1',
    ],
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(out.slice(out.indexOf('[')))[0]?.results as { identifier: string }[];
  const token = rows[0]?.identifier;
  if (!token) throw new Error('no verification row in the local D1');
  return `${API}/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(`${WEB}/`)}`;
};

const signUp = async (page: Page, email: string) => {
  await page.goto(`${WEB}/`);
  await page.evaluate(
    async ({ e, AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      const res = await auth.requestSignupLink(e);
      if (res.error) throw new Error(res.error.message);
    },
    { e: email, AUTH },
  );
  await page.goto(latestMagicLink());
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', message => console.log(`  [page ${message.type()}] ${message.text()}`));
  page.on('pageerror', error => console.log(`  [page error] ${error.message}`));

  const email = `draft-open-${Date.now()}@example.com`;
  await signUp(page, email);

  // A draft written the way `save_draft` writes one: straight into the record store.
  const draftKey = await page.evaluate(
    async ({ e, address, UNLOCK, KEYS, DRAFTS }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const d = (await import(DRAFTS)) as DraftsModule;
      const s = await u.createPasswordVault({ email: e, password: 'correct horse' });
      await s.store.put({
        type: 'address',
        naturalKey: address,
        plaintext: JSON.stringify({
          address,
          smtp: { host: 'smtp.example.com', port: 465, username: address, password: 'x' },
        }),
      });
      const outcome = await d.createDraft(
        s.store,
        {
          from: address,
          to: 'test@example.com',
          cc: '',
          bcc: '',
          subject: 'Repro subject',
          body: 'Repro body',
        },
        Date.now(),
      );
      if (!outcome.ok) throw new Error(`draft not created: ${outcome.reason}`);
      // A second draft with a different recipient, for switching while the composer stays open.
      const other = await d.createDraft(
        s.store,
        {
          from: address,
          to: 'second@example.com',
          cc: '',
          bcc: '',
          subject: 'Second subject',
          body: 'Second body',
        },
        Date.now(),
      );
      if (!other.ok) throw new Error(`second draft not created: ${other.reason}`);
      await k.saveUnlockKeys(await u.unlockKeysOf(s));
      return { first: outcome.handle.draftKey, second: other.handle.draftKey };
    },
    { e: email, address: ADDRESS, UNLOCK, KEYS, DRAFTS },
  );
  console.log(`✓ drafts written to the vault: ${draftKey.first}, ${draftKey.second}`);

  await page.goto(`${WEB}/m/unified?compose=draft:${draftKey.first}`);
  await page.waitForSelector('#compose-to', { timeout: 15_000 });
  // A controlled input keeps a stale `value` attribute, which is all a DOM snapshot sees.
  const fields = await page.evaluate(
    (selectors: readonly string[]) =>
      selectors.map(selector => {
        const element = document.querySelector(selector);
        return element === null
          ? null
          : {
              selector,
              property: (element as HTMLInputElement | HTMLTextAreaElement).value,
              attribute: element.getAttribute('value'),
            };
      }),
    ['#compose-to', '#compose-subject', 'textarea[aria-label="Message body, markdown"]'],
  );
  console.log('fresh load:', JSON.stringify(fields, null, 2));

  // The path `navigate` takes: a client-side navigation with the app already running.
  await page.goto(`${WEB}/m/unified`);
  await page.getByRole('link', { name: 'Drafts' }).click();
  await page
    .getByRole('link', { name: /Repro subject/ })
    .first()
    .click();
  await page.getByRole('link', { name: 'Edit draft' }).click();
  await page.waitForSelector('#compose-to', { timeout: 15_000 });
  console.log(`composer open at ${page.url()}`);
  const inApp = await page.evaluate(
    (selectors: readonly string[]) =>
      selectors.map(selector => {
        const element = document.querySelector(selector);
        return element === null
          ? null
          : {
              selector,
              property: (element as HTMLInputElement | HTMLTextAreaElement).value,
              attribute: element.getAttribute('value'),
            };
      }),
    ['#compose-to', '#compose-subject', 'textarea[aria-label="Message body, markdown"]'],
  );
  console.log('in-app open:', JSON.stringify(inApp, null, 2));

  // The intent changes from one draft to another without the dialog unmounting.
  await page.evaluate((key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('compose', `draft:${key}`);
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, draftKey.second);
  await page.waitForFunction(
    () =>
      (document.querySelector('#compose-subject') as HTMLInputElement | null)?.value ===
      'Second subject',
    undefined,
    { timeout: 15_000 },
  );
  const switched = await page.evaluate(
    (selectors: readonly string[]) =>
      selectors.map(selector => {
        const element = document.querySelector(selector);
        return element === null
          ? null
          : {
              selector,
              property: (element as HTMLInputElement | HTMLTextAreaElement).value,
              attribute: element.getAttribute('value'),
            };
      }),
    ['#compose-to', '#compose-subject', 'textarea[aria-label="Message body, markdown"]'],
  );
  console.log('switched while open:', JSON.stringify(switched, null, 2));

  // ChatGPT reads the accessibility tree, not the DOM, so the recipient rides in the accessible name.
  const tree = await page.locator('#compose-to').locator('xpath=..').ariaSnapshot();
  console.log('accessibility tree:');
  console.log(tree);
  if (!tree.includes('currently second@example.com')) {
    console.error("✗ the To field's accessible name has lost the recipient");
    process.exit(1);
  }

  await browser.close();
  if (switched[0]?.property !== 'second@example.com') {
    console.error('✗ switching drafts with the composer open left the wrong recipient on screen');
    process.exit(1);
  }
  if (inApp[0]?.property !== 'test@example.com') {
    console.error('✗ opened from inside the app, the To field lost the recipient');
    process.exit(1);
  }
  if (fields[0]?.property !== 'test@example.com') {
    console.error("✗ the To field does not hold the record's recipient");
    process.exit(1);
  }
  console.log('✓ the composer opened the draft with its recipient');
};

await run();
