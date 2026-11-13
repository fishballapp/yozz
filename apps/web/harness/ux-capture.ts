/**
 * Captures every screen of the app at desktop and phone width, so a design review judges the same
 * frames each round. The mail screens run on the demo fixtures; the sign-in screens run against a
 * fresh account in the local D1. Needs both dev servers up.
 *
 *   node harness/ux-capture.ts <output-dir> [scene-name-filter]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Browser, chromium, type Page } from '@playwright/test';

type AuthModule = typeof import('../src/vault/auth-client');
type UnlockModule = typeof import('../src/vault/unlock');
type KeysModule = typeof import('../src/vault/unlock-keys');
const AUTH = '/src/vault/auth-client.ts' as string;
const UNLOCK = '/src/vault/unlock.ts' as string;
const KEYS = '/src/vault/unlock-keys.ts' as string;

const WEB = process.env.YOZZ_WEB ?? 'http://localhost:5177';
const API = process.env.YOZZ_API ?? 'http://localhost:8177';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

type Scene = {
  readonly name: string;
  readonly path: string;
  /** Steps after the page settles and before the frame is taken. */
  readonly prepare?: (page: Page, viewport: ViewportName) => Promise<void>;
  readonly only?: ViewportName;
  readonly storage?: Readonly<Record<string, string>>;
};

const tickRows = async (page: Page, viewport: ViewportName) => {
  // A phone hides the checkboxes until Select is pressed.
  if (viewport === 'phone') await page.getByRole('button', { name: 'Select' }).click();
  const boxes = page.getByRole('checkbox');
  for (const index of [1, 2, 3]) {
    await boxes.nth(index).click({ force: true });
  }
};

const DEMO_SCENES: readonly Scene[] = [
  { name: 'inbox', path: '/m/unified' },
  { name: 'inbox-selection', path: '/m/unified', prepare: tickRows },
  { name: 'thread-html', path: '/m/unified/t/t-dune' },
  { name: 'thread-plain', path: '/m/unified/t/t-stripe' },
  { name: 'thread-multi-message', path: '/m/unified/t/t-dad' },
  { name: 'address-view', path: '/m/hello@stillwater.example' },
  { name: 'starred', path: '/m/starred' },
  { name: 'drafts', path: '/m/drafts' },
  { name: 'sent', path: '/m/sent' },
  { name: 'trash', path: '/m/trash' },
  { name: 'search-results', path: '/m/unified?q=receipt' },
  {
    name: 'search-failed',
    path: '/m/unified?q=receipt',
    storage: { 'yozz:demo-search': 'fail' },
  },
  { name: 'search-no-results', path: '/m/unified?q=zzzzqqq' },
  { name: 'thread-missing', path: '/m/unified/t/t-does-not-exist' },
  { name: 'compose-new', path: '/m/unified?compose=new' },
  { name: 'compose-reply', path: '/m/unified/t/t-dune?compose=reply:m-dune-1' },
  {
    name: 'compose-filled-preview',
    path: '/m/unified?compose=new',
    prepare: async page => {
      await page.locator('#compose-to').fill('kate@harbourlight.example');
      await page.locator('#compose-subject').fill('Thursday still good?');
      await page
        .getByLabel('Message body, markdown')
        .fill(
          'Hi Kate,\n\nStill on for **Thursday at 10**? Two things before then:\n\n- the revised quote\n- the [venue shortlist](https://example.com/venues)\n\nThanks,\nJason',
        );
      await page.getByRole('tab', { name: 'Preview' }).click();
    },
  },
  {
    name: 'navigation-sheet',
    path: '/m/unified',
    only: 'phone',
    prepare: async page => {
      await page.getByLabel('Open navigation').click();
    },
  },
  {
    name: 'row-hover',
    path: '/m/unified',
    only: 'desktop',
    prepare: async page => {
      await page
        .getByRole('link', { name: /Linear/u })
        .first()
        .hover();
    },
  },
  {
    name: 'search-focused',
    path: '/m/hello@stillwater.example',
    prepare: async page => {
      await page.getByLabel('Search mail').focus();
    },
  },
  {
    name: 'tooltip',
    path: '/m/unified/t/t-linear',
    only: 'desktop',
    prepare: async page => {
      await page.getByLabel('Archive thread').hover();
    },
  },
  {
    name: 'undo-toast',
    path: '/m/unified/t/t-linear',
    prepare: async page => {
      await page.getByLabel('Archive thread').click();
    },
  },
  {
    name: 'reply-menu',
    path: '/m/unified/t/t-dad',
    prepare: async page => {
      await page
        .getByLabel(/^Reply to or forward/u)
        .first()
        .click();
    },
  },
  {
    name: 'compose-from-open',
    path: '/m/unified?compose=new',
    prepare: async page => {
      await page.getByRole('dialog').getByRole('combobox').click();
    },
  },
  {
    name: 'compose-send-ready',
    path: '/m/unified?compose=new',
    only: 'desktop',
    prepare: async page => {
      await page.locator('#compose-to').fill('kate@harbourlight.example');
    },
  },
  {
    name: 'compose-cheat-sheet',
    path: '/m/unified?compose=new',
    prepare: async page => {
      await page.getByRole('button', { name: 'Markdown supported' }).click();
    },
  },
  {
    name: 'compose-discard-confirm',
    path: '/m/unified?compose=new',
    prepare: async page => {
      await page.locator('#compose-subject').fill('Thursday still good?');
      await page.getByRole('button', { name: 'Discard' }).click();
    },
  },
  {
    name: 'settings-new-address-sign-in',
    path: '/settings/new',
    prepare: async page => {
      await page.locator('input[type="email"]').first().fill('team@jyu.example');
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
    },
  },
  { name: 'settings', path: '/settings' },
  { name: 'settings-address', path: '/settings/a/jason@jyu.example' },
  { name: 'settings-new-address', path: '/settings/new' },
  {
    name: 'settings-new-address-servers',
    path: '/settings/new',
    prepare: async page => {
      await page.locator('input[type="email"]').first().fill('team@jyu.example');
      await page.getByRole('button', { name: 'Continue' }).click();
    },
  },
  { name: 'settings-images', path: '/settings/images' },
  { name: 'not-found', path: '/nowhere' },
];

const AUTH_SCENES: readonly Scene[] = [
  { name: 'welcome', path: '/welcome' },
  {
    name: 'welcome-link-sent',
    path: '/welcome',
    prepare: async page => {
      await page.locator('input[type="email"]').fill(`ux-capture-sent-${Date.now()}@example.com`);
      await page.locator('button[type="submit"]').click();
    },
  },
  { name: 'login', path: '/login' },
  { name: 'cli-approve-invalid', path: '/cli/approve?port=49152&state=abc' },
];

/** Screens that need an unlocked vault: a fresh account with a password, resumed on load. */
const VAULT_SCENES: readonly Scene[] = [
  { name: 'settings-sign-in', path: '/settings/account' },
  { name: 'settings-change-password', path: '/settings/account/password' },
  {
    name: 'cli-approve',
    path: `/cli/approve?port=53682&state=${'S'.repeat(43)}&publicKey=${'A'.repeat(43)}&name=jasons-mbp`,
  },
  { name: 'first-address', path: '/settings/new' },
  { name: 'inbox-no-address', path: '/m/unified' },
];

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

const settle = async (page: Page) => {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
};

const shoot = async (
  browser: Browser,
  out: string,
  scene: Scene,
  viewport: ViewportName,
  seed: (page: Page) => Promise<void>,
) => {
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewport],
    deviceScaleFactor: 2,
    hasTouch: viewport === 'phone',
  });
  const page = await context.newPage();
  const file = join(out, `${scene.name}--${viewport}.png`);
  try {
    await seed(page);
    if (scene.storage) {
      await page.evaluate(entries => {
        for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      }, scene.storage);
    }
    await page.goto(`${WEB}${scene.path}`);
    await settle(page);
    if (scene.prepare) {
      await scene.prepare(page, viewport);
      await settle(page);
    }
    await page.screenshot({ path: file });
    console.log(`✓ ${file}`);
  } catch (error) {
    await page.screenshot({ path: file }).catch(() => undefined);
    console.log(`✗ ${scene.name}--${viewport}: ${error instanceof Error ? error.message : error}`);
  } finally {
    await context.close();
  }
};

const run = async () => {
  const [outArg, filter] = process.argv.slice(2);
  if (!outArg) throw new Error('usage: node harness/ux-capture.ts <output-dir> [scene-filter]');
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const wanted = (scene: Scene) => filter === undefined || scene.name.includes(filter);

  const browser = await chromium.launch();
  try {
    const demo = async (page: Page) => {
      await page.goto(`${WEB}/welcome`);
      await page.evaluate(() => localStorage.setItem('yozz:demo', '1'));
    };
    const bare = async () => undefined;
    const signedIn = async (page: Page) => {
      await page.goto(`${WEB}/welcome`);
      await page.evaluate(
        async ({ email, AUTH }) => {
          const auth = (await import(AUTH)) as AuthModule;
          const res = await auth.requestSignupLink(email);
          if (res.error) throw new Error(res.error.message);
        },
        { email: `ux-capture-${Date.now()}@example.com`, AUTH },
      );
      await page.goto(latestMagicLink());
    };

    const unlocked = async (page: Page) => {
      await signedIn(page);
      await page.evaluate(
        async ({ AUTH, UNLOCK, KEYS }) => {
          const auth = (await import(AUTH)) as AuthModule;
          const unlock = (await import(UNLOCK)) as UnlockModule;
          const keys = (await import(KEYS)) as KeysModule;
          const { data } = await auth.getSession();
          if (!data) throw new Error('the magic link signed nobody in');
          const session = await unlock.createPasswordVault({
            account: { userId: data.user.id, email: data.user.email },
            password: 'correct horse battery',
          });
          await keys.saveUnlockKeys(await unlock.unlockKeysOf(session));
        },
        { AUTH, UNLOCK, KEYS },
      );
    };

    for (const viewport of ['desktop', 'phone'] as const) {
      for (const scene of DEMO_SCENES.filter(wanted)) {
        if (scene.only && scene.only !== viewport) continue;
        await shoot(browser, out, scene, viewport, demo);
      }
      for (const scene of AUTH_SCENES.filter(wanted)) {
        await shoot(browser, out, scene, viewport, bare);
      }
      const enrol: Scene = { name: 'enrol', path: '/enrol' };
      if (wanted(enrol)) await shoot(browser, out, enrol, viewport, signedIn);
      const enrolPassword: Scene = {
        name: 'enrol-password',
        path: '/enrol',
        prepare: async page => {
          await page.getByRole('button', { name: 'Use a password instead' }).click();
        },
      };
      if (wanted(enrolPassword)) await shoot(browser, out, enrolPassword, viewport, signedIn);
      for (const scene of VAULT_SCENES.filter(wanted)) {
        await shoot(browser, out, scene, viewport, unlocked);
      }
    }
  } finally {
    await browser.close();
  }
};

await run();
