# @internal/cookie-consent

Framework-free TypeScript cookie consent store and custom element for Astro marketing sites and React SPAs. Zero runtime dependencies. Complies with UK PECR and ICO guidance (equal weight Accept/Reject buttons, non-blocking bar, no cookies or storage written for analytics before consent, persisted choice in `localStorage`).

The package root (`@internal/cookie-consent`) exports only the store (`getConsent`, `setConsent`, `onConsentChange`, …). Import the custom element from `@internal/cookie-consent/element` so a server-side `getConsent` import never evaluates `class … extends HTMLElement`.

## Custom Element Usage

### Astro

Register the element and render `<cookie-consent>`:

```astro
<cookie-consent policy-href="/privacy"></cookie-consent>

<script>
  import '@internal/cookie-consent/element';
</script>
```

### React (React 19+)

React 19 natively supports custom elements and attributes:

```tsx
import '@internal/cookie-consent/element';

export function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <cookie-consent policy-href="/privacy" />
    </>
  );
}
```

### Reopening via "Cookie settings"

Any element with a `data-cookie-settings` attribute anywhere in the DOM will reopen the banner via a delegated click listener:

```html
<button type="button" data-cookie-settings>Cookie settings</button>
```

### Keeping clear of the banner

While the banner shows, the element sets `--cookie-consent-inset` on the root element to how much
of the window's bottom it covers (`0px` once it's answered), so a page can lift what must stay
visible: `bottom: calc(1.5rem + var(--cookie-consent-inset, 0px))`.

## Analytics Hook (e.g. PostHog)

Analytics libraries follow the store with `getConsent` (the stored choice, or `null` before one) and
`onConsentChange`. The store writes nothing until the visitor chooses, so a library that counts
without cookies or storage until then (as the marketing sites' PostHog does, with
`cookieless_mode: 'on_reject'` and `opt_out_capturing_by_default: true`) needs no call while the
choice is `null`:

```ts
import { type Consent, getConsent, onConsentChange } from '@internal/cookie-consent';

const applyConsent = (consent: Consent) => {
  if (consent === 'granted') {
    posthog.opt_in_capturing();
  } else {
    posthog.opt_out_capturing();
  }
};

// The stored choice on page load
const stored = getConsent();
if (stored !== null) applyConsent(stored);

// Each later Accept or Reject
onConsentChange(applyConsent);
```

The marketing sites' version, which skips PostHog's `$opt_in` event when re-applying a stored
choice, is `syncPostHogWithConsent` in `@internal/marketing/posthog`.
