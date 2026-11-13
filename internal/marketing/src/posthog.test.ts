import { COOKIE_CONSENT_KEY, setConsent } from '@internal/cookie-consent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capture, syncPostHogWithConsent } from './posthog';

const posthog = {
  capture: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
};

const storage = new Map<string, string>();

beforeEach(() => {
  vi.resetAllMocks();
  storage.clear();
  // A fresh EventTarget per test, so no consent listener outlives its test.
  globalThis.window = Object.assign(new EventTarget(), {
    posthog,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  }) as unknown as Window & typeof globalThis;
});

describe('capture', () => {
  it('sends the event before the visitor has chosen', () => {
    capture('cta_clicked', { cta: 'hero' });

    expect(posthog.capture).toHaveBeenCalledWith('cta_clicked', { cta: 'hero' });
  });
});

describe('syncPostHogWithConsent', () => {
  it('leaves PostHog in its cookieless default until the visitor chooses', () => {
    syncPostHogWithConsent();

    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
    expect(posthog.opt_out_capturing).not.toHaveBeenCalled();
  });

  it('re-applies a stored Accept without another $opt_in', () => {
    storage.set(COOKIE_CONSENT_KEY, 'granted');

    syncPostHogWithConsent();

    expect(posthog.opt_in_capturing).toHaveBeenCalledExactlyOnceWith({ captureEventName: false });
  });

  it('re-applies a stored Reject', () => {
    storage.set(COOKIE_CONSENT_KEY, 'denied');

    syncPostHogWithConsent();

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  });

  it('opts in, recording $opt_in, when the visitor accepts', () => {
    syncPostHogWithConsent();

    setConsent('granted');

    expect(posthog.opt_in_capturing).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('opts out when the visitor rejects', () => {
    syncPostHogWithConsent();

    setConsent('denied');

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
  });
});
