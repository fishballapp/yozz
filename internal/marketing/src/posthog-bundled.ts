import posthog from 'posthog-js/dist/module.slim.no-external';
import { syncPostHogWithConsent } from './posthog';

/**
 * Starts PostHog from npm, bundled into the page's own files, for a page whose CSP runs no
 * third-party script (`PostHogBundled.astro`). The slim, no-external build holds no code that
 * loads a script; the switches below also keep every feature that would ask for one off, and stop
 * the remote config and flags requests that could turn one on. What is left counts page views and
 * the page's own `capture()` calls, under the same consent as `PostHog.astro`.
 */
export const initBundledPostHog = ({ apiKey, host }: { apiKey: string; host: string }): void => {
  posthog.init(apiKey, {
    api_host: host,
    defaults: '2026-01-30',
    person_profiles: 'identified_only',
    cookieless_mode: 'on_reject',
    opt_out_capturing_by_default: true,
    // Its default sets the cookie on the parent domain, which would send it to every sibling host
    // (an app's API among them) with each request.
    cross_subdomain_cookie: false,
    // Data nobody reads: how far down the page someone scrolled, and ad-click IDs in the address.
    disable_scroll_properties: true,
    mask_personal_data_properties: true,
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    capture_performance: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    opt_in_site_apps: false,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
  });
  // capture() and syncPostHogWithConsent() from './posthog' reach PostHog here, as they reach the snippet's.
  window.posthog = posthog;
  syncPostHogWithConsent();
};

const readMeta = (name: string): string => {
  const content = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  if (content === undefined) throw new Error(`PostHogBundled: no <meta name="${name}">`);
  return content;
};

/**
 * Starts the PostHog that `PostHogBundled.astro` configured. The page calls it once it knows the
 * visit should be counted (YOZZ's landing page first rules out someone who uses the app).
 * Localhost is skipped, as by PostHog.astro: dev visits stay out of the project.
 */
export const startBundledPostHog = (): void => {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  initBundledPostHog({ apiKey: readMeta('posthog-api-key'), host: readMeta('posthog-host') });
};
