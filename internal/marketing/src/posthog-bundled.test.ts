import { setConsent } from '@internal/cookie-consent';
import type { PostHogConfig } from 'posthog-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));
vi.mock('posthog-js/dist/module.slim.no-external', () => ({ default: posthog }));

const { initBundledPostHog } = await import('./posthog-bundled');

const storage = new Map<string, string>();

beforeEach(() => {
  vi.resetAllMocks();
  storage.clear();
  globalThis.window = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  }) as unknown as Window & typeof globalThis;
});

/** The config `init` was given, after a start under the stored choice. */
const start = (): Partial<PostHogConfig> => {
  initBundledPostHog({ apiKey: 'phc_test', host: 'https://eu.i.posthog.com' });
  const config = posthog.init.mock.calls[0]?.[1];
  if (config === undefined) throw new Error('posthog.init was not called');
  return config;
};

describe('initBundledPostHog', () => {
  it("sets PostHog's cookie on the page's own host, not every sibling host", () => {
    expect(start().cross_subdomain_cookie).toBe(false);
  });

  it('counts a visitor who has not chosen, cookieless, and keeps counting one who rejects', () => {
    const config = start();

    expect(config).toMatchObject({
      cookieless_mode: 'on_reject',
      opt_out_capturing_by_default: true,
    });
    expect(config.before_send).toBeUndefined();
  });

  it("drops an earlier Accept's cookie when the visitor rejects", () => {
    start();

    setConsent('denied');

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  });
});
