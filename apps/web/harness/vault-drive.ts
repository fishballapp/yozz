/**
 * The vault's unlock flows in a real browser against `wrangler dev` and its local D1. Needs
 * both dev servers up (AGENTS.md, "Running the vault locally"). Chromium only: its CDP virtual
 * authenticator can do PRF headlessly.
 *
 *   pnpm -F @yozz.app/web vault:drive
 *   YOZZ_API=http://localhost:8792 pnpm -F @yozz.app/web vault:drive   # wrangler on another port
 *   YOZZ_WEB=http://localhost:5178 pnpm -F @yozz.app/web vault:drive   # vite on another port
 */
import { execFileSync } from 'node:child_process';
import { chromium, type Page } from '@playwright/test';

/** The page imports by the paths Vite serves, which TypeScript cannot resolve from here. */
type UnlockModule = typeof import('../src/vault/unlock');
type AuthModule = typeof import('../src/vault/auth-client');
type KeysModule = typeof import('../src/vault/unlock-keys');
const UNLOCK = '/src/vault/unlock.ts' as string;
const AUTH = '/src/vault/auth-client.ts' as string;
const KEYS = '/src/vault/unlock-keys.ts' as string;

const WEB = process.env.YOZZ_WEB ?? 'http://localhost:5177';
const API = process.env.YOZZ_API ?? 'http://localhost:8177';

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const assertEqual = (label: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
  console.log(`✓ ${label}`);
};

/** The magic link token lands in Better Auth's `verification` table. */
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
  const json = out.slice(out.indexOf('['));
  const rows = JSON.parse(json)[0]?.results as { identifier: string }[];
  const token = rows[0]?.identifier;
  if (!token) return fail('no verification row in the local D1');
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
  if (!page.url().startsWith(WEB)) fail(`magic link landed on ${page.url()}, want ${WEB}`);
};

const RECORD = { type: 'account', naturalKey: 'imap.example.com', plaintext: '{"user":"x"}' };

/** `VaultProvider`'s persisted unlock, driven by hand. */
const persistedUnlock = async (page: Page, label: string, userId: string) => {
  const resumed = await page.evaluate(
    async ({ record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.resumeSession();
      return s === null
        ? null
        : { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { record: RECORD, UNLOCK },
  );
  assertEqual(`${label}: reload, resume persisted unlock, read`, resumed?.got, {
    revision: 1,
    plaintext: RECORD.plaintext,
  });

  // A reset elsewhere must not be resumable here; only the server's stamp can say so.
  await page.evaluate(
    async ({ UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      await u.resetVaultAccount();
    },
    { UNLOCK },
  );
  await page.reload();
  const locked = await page.evaluate(
    async ({ UNLOCK, KEYS, id }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const resumed = await u.resumeSession();
      const stored = await k.loadUnlockKeys(id);
      return resumed === null
        ? stored === null
          ? 'locked, keys forgotten'
          : 'locked'
        : 'unlocked';
    },
    { UNLOCK, KEYS, id: userId },
  );
  assertEqual(
    `${label}: vault reset elsewhere, reload is locked`,
    locked,
    'locked, keys forgotten',
  );

  await page.evaluate(
    async ({ AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      await auth.signOut();
    },
    { AUTH },
  );
  const signedOut = await page.evaluate(
    async ({ UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      return (await u.resumeSession()) === null ? 'locked' : 'unlocked';
    },
    { UNLOCK },
  );
  assertEqual(`${label}: signed out, resume is locked`, signedOut, 'locked');
};

const passwordMode = async (page: Page) => {
  const email = `drive-pw-${Date.now()}@example.com`;
  await signUp(page, email);

  const created = await page.evaluate(
    async ({ e, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ email: e, password: 'correct horse' });
      await s.store.put(record);
      return { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { e: email, record: RECORD, UNLOCK },
  );
  assertEqual('password: create, write, read', created, {
    mode: 'password',
    got: { revision: 1, plaintext: RECORD.plaintext },
  });

  await page.reload();
  const reopened = await page.evaluate(
    async ({ e, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.loginWithPassword({ email: e, password: 'correct horse' });
      return await s.store.list(record.type);
    },
    { e: email, record: RECORD, UNLOCK },
  );
  assertEqual('password: reload, unlock, list', reopened, [
    { revision: 1, naturalKey: RECORD.naturalKey, plaintext: RECORD.plaintext },
  ]);

  const wrong = await page.evaluate(
    async ({ e, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      try {
        await u.loginWithPassword({ email: e, password: 'wrong' });
        return 'opened';
      } catch {
        return 'refused';
      }
    },
    { e: email, UNLOCK },
  );
  assertEqual('password: wrong password refused', wrong, 'refused');

  // A browser that has never seen this account reads the record from address and passphrase alone.
  const stranger = await openPage();
  await stranger.goto(`${WEB}/`);
  const fromStranger = await stranger.evaluate(
    async ({ e, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.loginWithPassword({ email: e, password: 'correct horse' });
      return await s.store.get(record.type, record.naturalKey);
    },
    { e: email, record: RECORD, UNLOCK },
  );
  await stranger.close();
  assertEqual('password: a browser with no local state logs in and reads', fromStranger, {
    revision: 1,
    plaintext: RECORD.plaintext,
  });

  const userId = await page.evaluate(
    async ({ e, UNLOCK, KEYS }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const s = await u.loginWithPassword({ email: e, password: 'correct horse' });
      await k.saveUnlockKeys(await u.unlockKeysOf(s));
      return s.userId;
    },
    { e: email, UNLOCK, KEYS },
  );
  await page.reload();
  await persistedUnlock(page, 'password', userId);
};

const passkeyMode = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
    },
  });

  await signUp(page, `drive-pk-${Date.now()}@example.com`);

  const created = await page.evaluate(
    async ({ record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasskeyVault();
      await s.store.put(record);
      return { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { record: RECORD, UNLOCK },
  );
  assertEqual('passkey: enrol (create + PRF assertion), write, read', created, {
    mode: 'passkey',
    got: { revision: 1, plaintext: RECORD.plaintext },
  });

  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assertEqual('passkey: exactly one credential on the authenticator', credentials.length, 1);

  await page.reload();
  const reopened = await page.evaluate(
    async ({ record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.loginWithPasskey();
      return { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { record: RECORD, UNLOCK },
  );
  assertEqual('passkey: reload, PRF sign-in, read', reopened, {
    mode: 'passkey',
    got: { revision: 1, plaintext: RECORD.plaintext },
  });

  const userId = await page.evaluate(
    async ({ UNLOCK, KEYS }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const s = await u.loginWithPasskey();
      await k.saveUnlockKeys(await u.unlockKeysOf(s));
      return s.userId;
    },
    { UNLOCK, KEYS },
  );
  await page.reload();
  await persistedUnlock(page, 'passkey', userId);
};

const browser = await chromium.launch();

/** `newPage` gives each call its own context. */
const openPage = async (): Promise<Page> => {
  const page = await browser.newPage();
  page.on('pageerror', err => fail(`page error: ${err.message}`));
  await page.addInitScript(api => {
    (window as { __YOZZ_API_URL__?: string }).__YOZZ_API_URL__ = api;
  }, API);
  return page;
};

try {
  for (const mode of [passwordMode, passkeyMode]) {
    const page = await openPage();
    await mode(page);
    await page.close();
  }
} finally {
  await browser.close();
}
