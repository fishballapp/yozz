import { POSTHOG_HOST } from '@yozz.app/web-marketing/analytics';
import { describe, expect, it, vi } from 'vitest';
import worker from './index';

const LANDING_PATH = '/_landing';

// The shape of apps/web/public/_headers' policy, which the assets layer attaches to every file.
const ORIGIN_CSP =
  "default-src 'self'; script-src 'self' 'sha256-abc='; connect-src 'self' https://api.yozz.app wss://api.yozz.app; frame-src 'self'; upgrade-insecure-requests";

const COUNTED_CSP = ORIGIN_CSP.replace(
  "connect-src 'self' https://api.yozz.app wss://api.yozz.app;",
  `connect-src 'self' https://api.yozz.app wss://api.yozz.app ${POSTHOG_HOST};`,
);

// What scripts/assemble-assets.ts writes for a landing build with one article.
const BLOG_MANIFEST = {
  html: ['/blog', '/blog/introducing-yozz'],
  assets: ['/blog/rss.xml'],
};

type Worker = typeof worker;
type Env = Parameters<Worker['fetch']>[1];

// The assets layer, answering with the path it was asked for, under the given policy: the blog
// manifest as JSON, and (like `not_found_handling: "single-page-application"`) a 200 for anything.
const assetsUnder = (policy: string, manifest: unknown = BLOG_MANIFEST) =>
  ({
    ASSETS: {
      fetch: async (input: RequestInfo | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input);
        const headers = { ETag: '"asset"', 'Content-Security-Policy': policy };
        if (pathname === '/_blog-manifest.json') {
          return manifest === null
            ? new Response('index.html', { status: 404, headers })
            : Response.json(manifest, { headers });
        }
        return new Response(pathname, { headers });
      },
    },
  }) as unknown as Env;

const getFrom = async (
  { fetch }: Worker,
  path: string,
  {
    method = 'GET',
    headers = {},
    env = assetsUnder(ORIGIN_CSP),
  }: { method?: string; headers?: HeadersInit; env?: Env } = {},
) => {
  const response = await fetch(
    new Request(`https://yozz.app${path}`, { method, headers }) as Parameters<Worker['fetch']>[0],
    env,
  );
  return {
    status: response.status,
    body: await response.text(),
    vary: response.headers.get('Vary'),
    csp: response.headers.get('Content-Security-Policy'),
    contentType: response.headers.get('Content-Type'),
    allow: response.headers.get('Allow'),
    location: response.headers.get('Location'),
  };
};

const get = async (path: string, headers: HeadersInit = {}, policy = ORIGIN_CSP) => {
  const { body, vary, csp } = await getFrom(worker, path, { headers, env: assetsUnder(policy) });
  return { body, vary, csp };
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
    expect((await get('/')).csp).toBe(COUNTED_CSP);
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

describe('yozz-web at /blog', () => {
  it('serves each blog page with PostHog in connect-src, the same to every browser', async () => {
    for (const path of BLOG_MANIFEST.html) {
      for (const headers of [{}, { Cookie: 'yozz-signed-in=1' }] as HeadersInit[]) {
        expect(await getFrom(worker, path, { headers })).toMatchObject({
          status: 200,
          body: path,
          vary: null,
          csp: COUNTED_CSP,
          location: null,
        });
      }
    }
  });

  it('sends another spelling of a page to the page, keeping the query', async () => {
    for (const [path, location] of [
      ['/blog/', 'https://yozz.app/blog'],
      ['/blog/introducing-yozz/', 'https://yozz.app/blog/introducing-yozz'],
      ['/blog/introducing-yozz.html', 'https://yozz.app/blog/introducing-yozz'],
      [
        '/blog/introducing-yozz/?utm_source=hn',
        'https://yozz.app/blog/introducing-yozz?utm_source=hn',
      ],
    ]) {
      expect(await getFrom(worker, path ?? '')).toMatchObject({ status: 307, location });
    }
  });

  it("serves the feed as application/rss+xml under the origin's CSP (including 304)", async () => {
    expect(await getFrom(worker, '/blog/rss.xml')).toMatchObject({
      status: 200,
      body: '/blog/rss.xml',
      vary: null,
      csp: ORIGIN_CSP,
      contentType: 'application/rss+xml; charset=utf-8',
      location: null,
    });
    const env304 = {
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          const { pathname } = new URL(input instanceof Request ? input.url : input);
          if (pathname === '/_blog-manifest.json') return Response.json(BLOG_MANIFEST);
          return new Response(null, {
            status: 304,
            headers: {
              'Content-Type': 'application/xml',
              'Content-Security-Policy': ORIGIN_CSP,
            },
          });
        },
      },
    } as unknown as Env;
    expect(await getFrom(worker, '/blog/rss.xml', { env: env304 })).toMatchObject({
      status: 304,
      body: '',
      csp: ORIGIN_CSP,
      contentType: 'application/rss+xml; charset=utf-8',
    });
  });

  it("answers an unknown blog address with the 404 page and a 404, never the app's shell", async () => {
    for (const path of ['/blog/does-not-exist', '/blog/a/b', '/blog/rss.xml/', '/blog/_landing']) {
      expect(await getFrom(worker, path)).toMatchObject({
        status: 404,
        body: '/404',
        vary: null,
        csp: ORIGIN_CSP,
        location: null,
      });
    }
    expect(await getFrom(worker, '/blog/does-not-exist', { method: 'HEAD' })).toMatchObject({
      status: 404,
      body: '',
      csp: ORIGIN_CSP,
    });
  });

  it('refuses non-GET/HEAD requests to the blog with 405', async () => {
    expect(await getFrom(worker, '/blog', { method: 'POST' })).toMatchObject({
      status: 405,
      body: '',
      allow: 'GET, HEAD',
    });
    expect(await getFrom(worker, '/blog/does-not-exist', { method: 'POST' })).toMatchObject({
      status: 405,
      body: '',
      allow: 'GET, HEAD',
    });
  });

  it('leaves an address that only starts like the blog to the assets', async () => {
    expect(await getFrom(worker, '/blogger')).toMatchObject({ status: 200, body: '/blogger' });
  });

  it('answers every blog address with a 404 while the landing build is missing', async () => {
    const env = assetsUnder(ORIGIN_CSP, { html: [], assets: [] });
    vi.resetModules();
    const fresh = (await import('./index')).default;
    expect(await getFrom(fresh, '/blog', { env })).toMatchObject({ status: 404, body: '/404' });
  });

  it('does not keep a manifest that failed to load', async () => {
    vi.resetModules();
    const fresh = (await import('./index')).default;
    await expect(getFrom(fresh, '/blog', { env: assetsUnder(ORIGIN_CSP, null) })).rejects.toThrow(
      /came back from the assets 404/,
    );
    await expect(
      getFrom(fresh, '/blog', { env: assetsUnder(ORIGIN_CSP, { html: '/blog' }) }),
    ).rejects.toThrow(/no string lists/);
    expect(await getFrom(fresh, '/blog')).toMatchObject({ status: 200, csp: COUNTED_CSP });
  });

  it('refuses a blog page that came back with no CSP to widen', async () => {
    const env = {
      ASSETS: {
        fetch: async (input: RequestInfo | URL) =>
          new URL(input instanceof Request ? input.url : input).pathname === '/_blog-manifest.json'
            ? Response.json(BLOG_MANIFEST)
            : new Response('page'),
      },
    } as unknown as Env;
    vi.resetModules();
    const fresh = (await import('./index')).default;
    await expect(getFrom(fresh, '/blog', { env })).rejects.toThrow(/no CSP/);
  });
});
