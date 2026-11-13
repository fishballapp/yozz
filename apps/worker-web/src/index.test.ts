import { POSTHOG_HOST } from '@yozz.app/web-marketing/analytics';
import { describe, expect, it } from 'vitest';
import worker from './index';

const LANDING_PATH = '/_landing';

// The shape of apps/web/public/_headers' policy, which the assets layer attaches to every file.
const ORIGIN_CSP =
  "default-src 'self'; script-src 'self' 'sha256-abc='; connect-src 'self' https://api.yozz.app wss://api.yozz.app; frame-src 'self'; upgrade-insecure-requests";

// The assets layer, answering with the path it was asked for, under the given policy.
const assetsUnder = (policy: string) =>
  ({
    ASSETS: {
      fetch: async (input: RequestInfo | URL) =>
        new Response(new URL(input instanceof Request ? input.url : input).pathname, {
          headers: { ETag: '"asset"', 'Content-Security-Policy': policy },
        }),
    },
  }) as unknown as Parameters<typeof worker.fetch>[1];

const get = async (path: string, headers: HeadersInit = {}, policy = ORIGIN_CSP) => {
  const response = await worker.fetch(
    new Request(`https://yozz.app${path}`, { headers }) as Parameters<typeof worker.fetch>[0],
    assetsUnder(policy),
  );
  return {
    body: await response.text(),
    vary: response.headers.get('Vary'),
    csp: response.headers.get('Content-Security-Policy'),
  };
};

describe('yozz-web at /', () => {
  it('serves the landing page to a browser that is not signed in', async () => {
    expect(await get('/')).toMatchObject({ body: LANDING_PATH, vary: 'Cookie' });
    expect(await get('/', { Cookie: 'other=1' })).toMatchObject({
      body: LANDING_PATH,
      vary: 'Cookie',
    });
  });

  it("serves the app's own / to a signed-in browser, which opens the inbox from there", async () => {
    expect(await get('/', { Cookie: 'a=b; yozz-signed-in=1' })).toMatchObject({
      body: '/',
      vary: 'Cookie',
    });
  });

  it('serves the landing page at /?cookie-settings to every browser, signed in or not', async () => {
    for (const headers of [{}, { Cookie: 'yozz-signed-in=1' }] as HeadersInit[]) {
      expect(await get('/?cookie-settings', headers)).toMatchObject({
        body: LANDING_PATH,
        vary: 'Cookie',
      });
    }
    expect(
      await get('/?cookie-settings=1&utm_source=x', { Cookie: 'yozz-signed-in=1' }),
    ).toMatchObject({
      body: LANDING_PATH,
    });
  });

  it('serves the app to a signed-in browser whatever else the query holds', async () => {
    expect(await get('/?utm_source=x', { Cookie: 'yozz-signed-in=1' })).toMatchObject({
      body: '/',
      vary: 'Cookie',
    });
  });

  it("leaves the policies to the assets, under the origin's CSP: they carry no analytics", async () => {
    for (const path of ['/privacy', '/terms']) {
      expect(await get(path)).toEqual({ body: path, vary: null, csp: ORIGIN_CSP });
    }
  });

  it('leaves every other path to the assets, untouched', async () => {
    expect(await get('/m/unified')).toEqual({ body: '/m/unified', vary: null, csp: ORIGIN_CSP });
    expect(await get('/welcome', { Cookie: 'yozz-signed-in=1' })).toEqual({
      body: '/welcome',
      vary: null,
      csp: ORIGIN_CSP,
    });
  });
});

describe("the landing page's CSP", () => {
  it("is the origin's, with PostHog's ingest host added to connect-src and nothing else", async () => {
    expect((await get('/')).csp).toBe(
      ORIGIN_CSP.replace(
        "connect-src 'self' https://api.yozz.app wss://api.yozz.app;",
        `connect-src 'self' https://api.yozz.app wss://api.yozz.app ${POSTHOG_HOST};`,
      ),
    );
  });

  it('is the landing CSP at /?cookie-settings, signed in or not', async () => {
    const landing = (await get('/')).csp;
    expect((await get('/?cookie-settings')).csp).toBe(landing);
    expect((await get('/?cookie-settings', { Cookie: 'yozz-signed-in=1' })).csp).toBe(landing);
  });

  it("is not given to the app's own /, which keeps the origin's byte for byte", async () => {
    expect((await get('/', { Cookie: 'yozz-signed-in=1' })).csp).toBe(ORIGIN_CSP);
  });

  it('refuses a policy it cannot widen by connect-src alone', async () => {
    await expect(get('/', {}, "default-src 'self'")).rejects.toThrow(/no connect-src/);
  });
});
