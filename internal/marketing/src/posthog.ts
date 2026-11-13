import { type Consent, getConsent, onConsentChange } from '@internal/cookie-consent';

declare global {
  interface Window {
    /** The PostHog snippet's stub until the SDK loads, then the SDK; both queue these calls. */
    posthog?: {
      capture?: (event: string, properties?: Record<string, unknown>) => void;
      opt_in_capturing?: (options?: { captureEventName?: string | null | false }) => void;
      opt_out_capturing?: () => void;
    };
  }
}

/**
 * Capture a marketing event, whatever the visitor's consent: PostHog counts it cookieless until
 * they accept (see `PostHog.astro`). A no-op where the snippet isn't on the page.
 */
export const capture = (event: string, properties?: Record<string, unknown>): void => {
  window.posthog?.capture?.(event, properties);
};

const applyConsent = (consent: Consent, isUserAction: boolean): void => {
  if (consent === 'denied') {
    window.posthog?.opt_out_capturing?.();
    return;
  }
  // Re-applying a stored choice on page load must not record another `$opt_in` event.
  window.posthog?.opt_in_capturing?.(isUserAction ? undefined : { captureEventName: false });
};

/** Makes PostHog follow the `@internal/cookie-consent` store: the stored choice now, each
 * change later. With no choice yet it leaves PostHog in its pending, cookieless state. */
export const syncPostHogWithConsent = (): void => {
  const stored = getConsent();
  if (stored !== null) applyConsent(stored, false);
  onConsentChange(consent => applyConsent(consent, true));
};
