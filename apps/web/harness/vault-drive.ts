/**
 * Drives the vault's unlock flows in a real browser against `wrangler dev` and its local D1; needs
 * both dev servers up. Chromium only: its CDP virtual authenticator can do PRF headlessly.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Page } from '@playwright/test';
import {
  deriveCliKeys,
  generateCliKeyPair,
  openCliLogin,
  openVault,
  pairingCode,
} from '@yozz.app/vault';
import {
  ACCOUNT_HEADER,
  CliKeyWrapResponseSchema,
  CliLoginCallbackSchema,
  VaultRecordEnvelopeSchema,
} from '@yozz.app/vault-contract';
import { fullDate } from '../src/ui/time.ts';

/** The page imports by the paths Vite serves, which TypeScript cannot resolve from here. */
type UnlockModule = typeof import('../src/vault/unlock');
type VaultAccount = import('../src/vault/unlock').VaultAccount;
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

/** Resolves to the account the link signed in, which a vault is created for. */
const signUp = async (page: Page, email: string): Promise<VaultAccount> => {
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
  return page.evaluate(
    async ({ AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      const { data } = await auth.getSession();
      if (!data) throw new Error('the magic link signed nobody in');
      return { userId: data.user.id, email: data.user.email };
    },
    { AUTH },
  );
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
    async ({ UNLOCK, userId }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      await u.resetVaultAccount(userId);
    },
    { UNLOCK, userId },
  );
  await page.reload();
  const locked = await page.evaluate(
    async ({ UNLOCK, KEYS, id }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const resumed = await u.resumeSession();
      const stored = await k.loadUnlockKeys(id);
      if (resumed !== null) return 'unlocked';
      return stored === null ? 'locked, keys forgotten' : 'locked';
    },
    { UNLOCK, KEYS, id: userId },
  );
  assertEqual(
    `${label}: vault reset elsewhere, reload is locked`,
    locked,
    'locked, keys forgotten',
  );

  await page.evaluate(
    async ({ AUTH, userId }) => {
      const auth = (await import(AUTH)) as AuthModule;
      await auth.signOut(userId);
    },
    { AUTH, userId },
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
  const account = await signUp(page, email);

  const created = await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ account, password: 'correct horse' });
      await s.store.put(record);
      return { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { account, record: RECORD, UNLOCK },
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

/**
 * A password change from one device: the data is still there under the new password, and the old
 * password and every other device are shut out.
 */
const passwordChange = async (page: Page) => {
  const email = `drive-change-${Date.now()}@example.com`;
  const account = await signUp(page, email);
  await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ account, password: 'correct horse' });
      await s.store.put(record);
    },
    { account, record: RECORD, UNLOCK },
  );

  const otherDevice = await openPage();
  await otherDevice.goto(`${WEB}/`);
  const before = await otherDevice.evaluate(
    async ({ e, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.loginWithPassword({ email: e, password: 'correct horse' });
      return await s.store.get(record.type, record.naturalKey);
    },
    { e: email, record: RECORD, UNLOCK },
  );
  assertEqual('password change: another device signs in and reads', before, {
    revision: 1,
    plaintext: RECORD.plaintext,
  });

  const changed = await page.evaluate(
    async ({ e, record, UNLOCK, KEYS }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const s = await u.loginWithPassword({ email: e, password: 'correct horse' });
      const result = await u.changePasswordOfSession({
        currentSession: s,
        isCurrent: () => true,
        currentPassword: 'correct horse',
        newPassword: 'battery staple',
      });
      if (result.outcome !== 'changed') throw new Error('the change ended');
      await k.saveUnlockKeys(await u.unlockKeysOf(result.session));
      return await result.session.store.get(record.type, record.naturalKey);
    },
    { e: email, record: RECORD, UNLOCK, KEYS },
  );
  assertEqual('password change: changed here, the same session still reads', changed, {
    revision: 1,
    plaintext: RECORD.plaintext,
  });

  const otherSession = await otherDevice.evaluate(
    async ({ AUTH }) => {
      const auth = (await import(AUTH)) as AuthModule;
      return (await auth.getSession()).data === null ? 'signed out' : 'signed in';
    },
    { AUTH },
  );
  assertEqual('password change: the other device is signed out', otherSession, 'signed out');
  await otherDevice.close();

  const fresh = await openPage();
  await fresh.goto(`${WEB}/`);
  const attempt = (password: string) =>
    fresh.evaluate(
      async ({ e, password, record, UNLOCK }) => {
        const u = (await import(UNLOCK)) as UnlockModule;
        try {
          const s = await u.loginWithPassword({ email: e, password });
          return await s.store.get(record.type, record.naturalKey);
        } catch {
          return 'refused';
        }
      },
      { e: email, password, record: RECORD, UNLOCK },
    );
  assertEqual(
    'password change: the old password is refused',
    await attempt('correct horse'),
    'refused',
  );
  assertEqual(
    'password change: a fresh browser signs in with the new one and reads',
    await attempt('battery staple'),
    { revision: 1, plaintext: RECORD.plaintext },
  );
  await fresh.close();

  await page.reload();
  await persistedUnlock(page, 'password changed', account.userId);
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

  const account = await signUp(page, `drive-pk-${Date.now()}@example.com`);

  const created = await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasskeyVault({ account });
      await s.store.put(record);
      return { mode: s.mode, got: await s.store.get(record.type, record.naturalKey) };
    },
    { account, record: RECORD, UNLOCK },
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

/** The Worker only accepts a change to how the vault opens from a sign-in under a day old. */
const ageSessions = () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  execFileSync(
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
      '--command',
      `UPDATE session SET createdAt = '${twoDaysAgo}'`,
    ],
    { encoding: 'utf8' },
  );
};

/**
 * Through the real Settings screen: a session older than a day may not change how the vault opens,
 * so the switch asks for the current password and then goes through.
 */
const staleSession = async (page: Page) => {
  const email = `drive-stale-${Date.now()}@example.com`;
  const account = await signUp(page, email);
  await page.evaluate(
    async ({ account, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      await u.createPasswordVault({ account, password: 'correct horse' });
    },
    { account, UNLOCK },
  );

  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct horse');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(`${WEB}/m/unified`);

  ageSessions();

  // Through the real screen: changing the password from a day-old sign-in asks to confirm first.
  await page.goto(`${WEB}/settings/account/password`);
  await page.getByLabel('Current password').fill('correct horse');
  await page.getByLabel('New password', { exact: true }).fill('battery staple');
  await page.getByLabel('Confirm new password').fill('battery staple');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('heading', { name: 'Confirm it’s you' }).waitFor({ timeout: 30_000 });
  assertEqual('stale session: Settings asks to confirm before changing the password', true, true);
  await page.getByLabel('Current password').last().fill('correct horse');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  const changed = page.getByText('Password changed.', { exact: true });
  await changed.waitFor({ timeout: 30_000 });
  assertEqual('stale session: confirmed, then the password changed', await changed.count(), 1);
  // The change signed every other session out and the confirmation made a fresh one: age it again.
  ageSessions();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
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

  await page.goto(`${WEB}/settings/account/passkey`);
  await page.getByRole('button', { name: 'Switch to a passkey' }).click();
  await page.getByRole('heading', { name: 'Confirm it’s you' }).waitFor();
  assertEqual('stale session: Settings asks to confirm before switching', true, true);

  await page.getByLabel('Current password').fill('battery staple');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  // Derivation, then the passkey's create and PRF assertion: the switch lands after the panel goes.
  const opens = page.getByText('You sign in with a passkey.', { exact: true });
  await opens.waitFor({ timeout: 30_000 });
  assertEqual('stale session: confirmed, then switched to a passkey', await opens.count(), 1);
};

/**
 * Through the real Settings screen: deleting an account signs the person out with a line saying so,
 * the old password opens nothing, and the same address registers again as a new account with none of
 * the old data.
 */
const accountDeletion = async (page: Page) => {
  const email = `drive-delete-${Date.now()}@example.com`;
  const account = await signUp(page, email);
  await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ account, password: 'correct horse' });
      await s.store.put(record);
    },
    { account, record: RECORD, UNLOCK },
  );

  await page.goto(`${WEB}/login`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('correct horse');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(`${WEB}/m/unified`);

  // In the app, not a reload: the keys that resume a reload are saved a moment after the login.
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: /^Sign-in/ }).click();
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  const confirm = page.getByRole('alertdialog').getByRole('button', { name: 'Delete account' });
  assertEqual('delete: Delete account waits for the word', await confirm.isDisabled(), true);
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await page.waitForURL(/\/login\?deleted=true/, { timeout: 30_000 });
  const line = page.getByText('Your account was deleted.', { exact: true });
  await line.waitFor();
  assertEqual('delete: signed out, saying so', await line.count(), 1);

  const attempt = (password: string) =>
    page.evaluate(
      async ({ e, password, UNLOCK }) => {
        const u = (await import(UNLOCK)) as UnlockModule;
        try {
          await u.loginWithPassword({ email: e, password });
          return 'opened';
        } catch {
          return 'refused';
        }
      },
      { e: email, password, UNLOCK },
    );
  assertEqual('delete: the old password opens nothing', await attempt('correct horse'), 'refused');

  const again = await signUp(page, email);
  assertEqual(
    'delete: the same address registers as a new account',
    again.userId !== account.userId,
    true,
  );
  const fresh = await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ account, password: 'correct horse' });
      return await s.store.get(record.type, record.naturalKey);
    },
    { account: again, record: RECORD, UNLOCK },
  );
  assertEqual('delete: and none of the old data is in it', fresh, null);
};

/**
 * Through the real Settings screen, with two authenticators (one passkey per authenticator, as a
 * second device would be): the list shows each passkey, the only one has no Remove, a removed
 * passkey can no longer sign in, and the last one cannot be removed.
 */
const passkeyRemoval = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const options = {
    protocol: 'ctap2',
    ctap2Version: 'ctap2_1',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    hasPrf: true,
  } as const;
  const first = (await cdp.send('WebAuthn.addVirtualAuthenticator', { options })).authenticatorId;
  const credentialsOn = async (authenticatorId: string) =>
    (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;

  const account = await signUp(page, `drive-remove-${Date.now()}@example.com`);
  await page.evaluate(
    async ({ account, record, UNLOCK, KEYS }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const k = (await import(KEYS)) as KeysModule;
      const s = await u.createPasskeyVault({ account });
      await s.store.put(record);
      await k.saveUnlockKeys(await u.unlockKeysOf(s));
    },
    { account, record: RECORD, UNLOCK, KEYS },
  );

  await page.goto(`${WEB}/settings/account`);
  const section = page.locator('section:not(:has(section))', {
    has: page.getByRole('heading', { name: 'Passkeys', exact: true }),
  });
  const rows = section.getByRole('listitem');
  await rows.first().waitFor({ timeout: 30_000 });
  assertEqual('remove: the only passkey is listed', await rows.count(), 1);
  assertEqual(
    'remove: and has no Remove, only the line saying to add another',
    [
      await section.getByRole('button', { name: /^Remove/ }).count(),
      await section
        .getByText('This is your only passkey. Add another before you can remove it.')
        .count(),
    ],
    [0, 1],
  );

  // The first authenticator holds this account's passkey, so a second device is a second authenticator.
  const second = (
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { ...options, transport: 'usb' },
    })
  ).authenticatorId;
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await page.getByText('Added. That passkey can now sign you in.').waitFor({ timeout: 30_000 });
  // The name dialog opens at once, prefilled with this browser's name and selected.
  const nameDialog = page.getByRole('alertdialog', { name: 'Name this passkey' });
  const nameField = nameDialog.getByLabel('Name');
  await nameField.waitFor();
  const automatic = await nameField.inputValue();
  const selection = await nameField.evaluate((input: HTMLInputElement) => [
    input.selectionStart,
    input.selectionEnd,
  ]);
  assertEqual('remove: the new passkey asks for a name, selected', selection, [
    0,
    automatic.length,
  ]);
  assertEqual(
    'remove: prefilled with the browser and system',
    /^[A-Za-z]+ on [A-Za-z]+$/.test(automatic),
    true,
  );
  await nameField.fill('Work laptop');
  await nameField.press('Enter');
  await nameDialog.waitFor({ state: 'detached', timeout: 30_000 });
  await rows.filter({ hasText: 'Work laptop' }).waitFor();
  const names = await page.evaluate(
    async ({ UNLOCK, userId }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      return (await u.listPasskeys(userId)).map(passkey => passkey.name);
    },
    { UNLOCK, userId: account.userId },
  );
  assertEqual('remove: Enter saved the name; the first passkey has the automatic one', names, [
    automatic,
    'Work laptop',
  ]);
  assertEqual('remove: after adding one, the list shows two', await rows.count(), 2);
  assertEqual(
    'remove: each with a Remove',
    await section.getByRole('button', { name: /^Remove/ }).count(),
    2,
  );
  assertEqual(
    'remove: the second device holds the new passkey',
    (await credentialsOn(second)).length,
    1,
  );

  // The oldest is the one the vault was created with. Removing it asks first, then it is gone.
  await rows
    .first()
    .getByRole('button', { name: /^Remove/ })
    .click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByText('Your other passkeys still work.').waitFor();
  await dialog.getByRole('button', { name: 'Remove passkey', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('section li').length === 1);
  assertEqual(
    'remove: the first passkey is gone, the last one has no Remove',
    [
      await rows.count(),
      await section.getByRole('button', { name: /^Remove/ }).count(),
      await section
        .getByText('This is your only passkey. Add another before you can remove it.')
        .count(),
    ],
    [1, 0, 1],
  );

  // Removing the passkey this device opened with leaves the device signed in, even across a reload.
  await page.reload();
  await rows.first().waitFor({ timeout: 30_000 });
  assertEqual('remove: a reload still resumes the session', await rows.count(), 1);

  const attempt = async (enabled: string, disabled: string) => {
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: disabled,
      enabled: false,
    });
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: enabled,
      enabled: true,
    });
    return page.evaluate(
      async ({ record, UNLOCK, AUTH, userId }) => {
        const u = (await import(UNLOCK)) as UnlockModule;
        const auth = (await import(AUTH)) as AuthModule;
        await auth.signOut(userId);
        try {
          const s = await u.loginWithPasskey();
          return await s.store.get(record.type, record.naturalKey);
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
      { record: RECORD, UNLOCK, AUTH, userId: account.userId },
    );
  };
  assertEqual(
    'remove: the removed passkey can no longer sign in',
    await attempt(first, second),
    'refused: Passkey not found',
  );
  assertEqual(
    'remove: the one that is left signs in and opens the data',
    await attempt(second, first),
    {
      revision: 1,
      plaintext: RECORD.plaintext,
    },
  );

  const lastRefused = await page.evaluate(
    async ({ UNLOCK, userId }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const [last] = await u.listPasskeys(userId);
      if (last === undefined) throw new Error('no passkey left');
      try {
        await u.removePasskey({ userId, credentialId: last.credentialId });
        return 'removed';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    { UNLOCK, userId: account.userId },
  );
  assertEqual(
    'remove: the last passkey is refused by the Worker, and still there',
    lastRefused,
    'This is the only passkey that can sign in. Add another before you remove it.',
  );
};

/** `yozz login`'s one-shot listener, as a stand-in: each callback the browser lands on, in order. */
const startLoopback = async () => {
  const callbacks: URLSearchParams[] = [];
  const waiting: ((query: URLSearchParams) => void)[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // The browser asks for a favicon too.
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Back to your terminal.');
    const query = url.searchParams;
    const next = waiting.shift();
    if (next === undefined) {
      callbacks.push(query);
      return;
    }
    next(query);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    next: () =>
      new Promise<URLSearchParams>(resolve => {
        const ready = callbacks.shift();
        if (ready === undefined) {
          waiting.push(resolve);
          return;
        }
        resolve(ready);
      }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
};

/** What `yozz login` would make: a key pair, a state, and the link it opens. */
const cliLogin = async (port: number, name: string) => {
  const pair = await generateCliKeyPair();
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const query = new URLSearchParams({ port: String(port), state, publicKey: pair.publicKey, name });
  return { ...pair, state, link: `${WEB}/cli/approve?${query}` };
};

/** The CLI's whole side, with nothing but the callback and its private key. */
const openAsCli = async (
  login: { readonly privateKey: string; readonly state: string },
  callback: URLSearchParams,
) => {
  const answer = CliLoginCallbackSchema.parse(Object.fromEntries(callback));
  if (!('sealedLogin' in answer)) return fail('the approval came back denied');
  if (answer.state !== login.state) fail('the callback names another login');
  const keys = await deriveCliKeys({
    privateKey: login.privateKey,
    ephemeralPublicKey: answer.ephemeralPublicKey,
  });
  const { token, userId } = await openCliLogin(keys.tokenKey, {
    state: login.state,
    sealedLogin: answer.sealedLogin,
  });
  const bearer = (path: string) =>
    fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, [ACCOUNT_HEADER]: userId },
    });
  const wrap = await bearer('/api/v1/vault/cli-key');
  if (!wrap.ok) return { token, userId, bearer, vault: null };
  const { wrappedDek } = CliKeyWrapResponseSchema.parse(await wrap.json());
  return { token, userId, bearer, vault: await openVault(keys, wrappedDek) };
};

/**
 * `/cli/approve` through the real screens, with a loopback listener standing in for the CLI: a
 * locked tab goes through Log in and back, Approve hands over a login the CLI opens into the same
 * vault, Deny says so, a day-old sign-in confirms first, and Settings lists and revokes the keys.
 */
const cliApproval = async (page: Page) => {
  const email = `drive-cli-${Date.now()}@example.com`;
  const account = await signUp(page, email);
  await page.evaluate(
    async ({ account, record, UNLOCK }) => {
      const u = (await import(UNLOCK)) as UnlockModule;
      const s = await u.createPasswordVault({ account, password: 'correct horse' });
      await s.store.put(record);
    },
    { account, record: RECORD, UNLOCK },
  );
  // Signed in, but this tab holds no keys: the vault is locked.
  await page.reload();

  const loopback = await startLoopback();
  try {
    await page.goto(`${WEB}/cli/approve?port=80&state=x`);
    const invalid = page.getByRole('heading', { name: 'This link isn’t a YOZZ CLI approval' });
    await invalid.waitFor();
    assertEqual('cli: a link yozz login did not make says so', await invalid.count(), 1);

    const first = await cliLogin(loopback.port, 'drive-laptop');
    await page.goto(first.link);
    await page.waitForURL(/\/login\?approve=/);
    assertEqual('cli: a locked tab goes through Log in', true, true);
    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('correct horse');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.waitForURL(first.link, { timeout: 30_000 });
    assertEqual('cli: and comes back to the approval with its query', page.url(), first.link);

    const code = page.getByText(await pairingCode(first.publicKey), { exact: true });
    await code.waitFor();
    assertEqual('cli: the page shows the code the terminal shows', await code.count(), 1);

    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const approved = await openAsCli(first, await loopback.next());
    assertEqual('cli: the sealed login names this account', approved.userId, account.userId);
    if (approved.vault === null) return fail('the CLI key opened no wrap');
    const id = await approved.vault.recordId(RECORD.type, RECORD.naturalKey);
    const res = await approved.bearer(`/api/v1/vault/records/${RECORD.type}/${id}`);
    const envelope = VaultRecordEnvelopeSchema.parse(await res.json());
    const opened = await approved.vault.decryptRecord({ ...RECORD, ...envelope });
    assertEqual(
      'cli: the CLI opens the vault and reads the record',
      opened.plaintext,
      RECORD.plaintext,
    );

    const denied = await cliLogin(loopback.port, 'drive-stranger');
    await page.goto(denied.link);
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    assertEqual(
      'cli: Deny tells the CLI so, and nothing else',
      Object.fromEntries(await loopback.next()),
      { state: denied.state, error: 'denied' },
    );

    ageSessions();
    const second = await cliLogin(loopback.port, 'drive-ci');
    await page.goto(second.link);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('heading', { name: 'Confirm it’s you' }).waitFor({ timeout: 30_000 });
    assertEqual('cli: a day-old sign-in confirms before approving', true, true);
    await page.getByLabel('Current password').fill('correct horse');
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const secondCli = await openAsCli(second, await loopback.next());
    assertEqual('cli: then the approval goes through', secondCli.vault !== null, true);

    await page.goto(`${WEB}/settings/account`);
    const today = fullDate(Date.now());
    const rows = page.getByRole('listitem').filter({ hasText: /^drive-/ });
    await rows.first().waitFor();
    assertEqual(
      'cli: Settings lists both keys, with the codes and when each was used',
      await rows.allTextContents(),
      [
        `drive-laptop${await pairingCode(first.publicKey)} · Added ${today} · Last used ${today}Revoke`,
        `drive-ci${await pairingCode(second.publicKey)} · Added ${today} · Last used ${today}Revoke`,
      ],
    );

    await page
      .getByRole('button', { name: `Revoke drive-laptop (${await pairingCode(first.publicKey)})` })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke key' }).click();
    await page
      .getByText('drive-laptop', { exact: true })
      .waitFor({ state: 'detached', timeout: 30_000 });
    const revoked = await approved.bearer('/api/v1/vault/cli-key');
    assertEqual('cli: Revoke removes the key, and its bearer opens nothing', revoked.status, 401);
  } finally {
    await loopback.close();
  }
};

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
  for (const mode of [
    passwordMode,
    passwordChange,
    passkeyMode,
    staleSession,
    accountDeletion,
    passkeyRemoval,
    cliApproval,
  ]) {
    const page = await openPage();
    await mode(page);
    await page.close();
  }
} finally {
  await browser.close();
}
