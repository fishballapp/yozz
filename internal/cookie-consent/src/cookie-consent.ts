import { getConsent, setConsent } from './consent.ts';

const STYLE_ID = 'fishball-cookie-consent-styles';

/**
 * How much of the window's bottom the banner covers while it shows (`0px` once answered), set on
 * the root element so a page can keep what matters clear of it.
 */
export const COOKIE_CONSENT_INSET = '--cookie-consent-inset';

const STYLES = `
cookie-consent {
  display: block;
}
cookie-consent[hidden] {
  display: none !important;
}
.cookie-consent-bar {
  position: fixed;
  bottom: max(0.5rem, env(safe-area-inset-bottom));
  left: 0.5rem;
  right: 0.5rem;
  margin-left: auto;
  margin-right: auto;
  max-width: 44rem;
  z-index: 9999;
  box-sizing: border-box;
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  border-radius: var(--radius-lg, var(--radius, var(--dm-radius, 10px)));
  background-color: var(--color-card, var(--card, var(--dm-bg-secondary, var(--color-background, var(--background, var(--dm-bg, #ffffff))))));
  color: var(--color-foreground, var(--foreground, var(--dm-fg, #111111)));
  border: 1px solid var(--color-border, var(--border, var(--dm-border, rgba(0, 0, 0, 0.15))));
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem 0.75rem;
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.35;
}
@media (min-width: 640px) {
  .cookie-consent-bar {
    bottom: max(1rem, env(safe-area-inset-bottom));
    left: 1rem;
    right: 1rem;
    padding: 0.625rem 0.625rem 0.625rem 1.25rem;
    gap: 0.5rem 1.5rem;
    font-size: 0.875rem;
    line-height: 1.45;
  }
}
.cookie-consent-text {
  margin: 0;
  flex: 1 1 11rem;
  color: var(--color-muted-foreground, var(--muted-foreground, var(--dm-fg-muted, #555555)));
}
.cookie-consent-link {
  color: var(--color-foreground, var(--foreground, var(--dm-fg, inherit)));
  text-decoration: underline;
  text-underline-offset: 3px;
  white-space: nowrap;
}
.cookie-consent-link:hover {
  color: var(--color-accent, var(--accent, var(--dm-accent, inherit)));
}
.cookie-consent-link:focus-visible {
  outline: 2px solid var(--color-foreground, var(--foreground, var(--dm-fg, currentColor)));
  outline-offset: 2px;
  border-radius: 2px;
}
.cookie-consent-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}
.cookie-consent-btn {
  min-height: 2.75rem;
  padding: 0 0.75rem;
  font-family: inherit;
  font-size: inherit;
  font-weight: 500;
  line-height: 1.25;
  white-space: nowrap;
  text-align: center;
  cursor: pointer;
  box-sizing: border-box;
  border-radius: var(--radius-md, var(--radius-sm, var(--radius, var(--dm-radius, 6px))));
  border: 1px solid var(--color-border, var(--border, var(--dm-border, rgba(0, 0, 0, 0.18))));
  background-color: var(--color-muted, var(--muted, var(--dm-bg-tertiary, var(--color-card, var(--card, rgba(0, 0, 0, 0.04))))));
  color: var(--color-foreground, var(--foreground, var(--dm-fg, #111111)));
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
@media (min-width: 640px) {
  .cookie-consent-btn {
    min-height: 2.25rem;
    min-width: 5rem;
    padding: 0 1rem;
  }
}
.cookie-consent-btn:hover {
  background-color: var(--color-border, var(--border, var(--dm-border, rgba(0, 0, 0, 0.08))));
}
.cookie-consent-btn:focus-visible {
  outline: 2px solid var(--color-foreground, var(--foreground, var(--dm-fg, currentColor)));
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .cookie-consent-bar,
  .cookie-consent-btn,
  .cookie-consent-link {
    transition: none !important;
    animation: none !important;
  }
}
`;

const injectStyles = () => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
};

let isListenerAttached = false;

const attachDelegatedListener = () => {
  if (isListenerAttached || typeof document === 'undefined') return;
  isListenerAttached = true;

  document.addEventListener('click', event => {
    const target = event.target as Element | null;
    if (target?.closest('[data-cookie-settings]')) {
      event.preventDefault();
      const el = document.querySelector('cookie-consent') as CookieConsentElement | null;
      if (el) {
        el.show();
        el.querySelector<HTMLButtonElement>('.cookie-consent-btn')?.focus();
      }
    }
  });
};

const DEFAULT_MESSAGE = 'We use cookies for analytics, to see how people use this site.';
const DEFAULT_POLICY_LABEL = 'Privacy Policy';
const DEFAULT_REJECT_LABEL = 'Reject';
const DEFAULT_ACCEPT_LABEL = 'Accept';

export class CookieConsentElement extends HTMLElement {
  static get observedAttributes() {
    return ['policy-href', 'message', 'policy-label', 'reject-label', 'accept-label'];
  }

  private isBuilt = false;
  private messageSpan: HTMLSpanElement | null = null;
  private policyLink: HTMLAnchorElement | null = null;
  private rejectBtn: HTMLButtonElement | null = null;
  private acceptBtn: HTMLButtonElement | null = null;

  connectedCallback(): void {
    injectStyles();
    attachDelegatedListener();

    if (this.isBuilt) return;
    this.isBuilt = true;

    this.setAttribute('role', 'region');
    if (!this.hasAttribute('aria-label')) {
      this.setAttribute('aria-label', 'Cookie consent');
    }

    const bar = document.createElement('div');
    bar.className = 'cookie-consent-bar';

    const text = document.createElement('p');
    text.className = 'cookie-consent-text';

    this.messageSpan = document.createElement('span');
    this.messageSpan.textContent = this.getAttribute('message') || DEFAULT_MESSAGE;

    this.policyLink = document.createElement('a');
    this.policyLink.className = 'cookie-consent-link';
    this.policyLink.href = this.getAttribute('policy-href') || '/privacy';
    this.policyLink.textContent = this.getAttribute('policy-label') || DEFAULT_POLICY_LABEL;

    text.appendChild(this.messageSpan);
    text.appendChild(document.createTextNode(' '));
    text.appendChild(this.policyLink);

    const actions = document.createElement('div');
    actions.className = 'cookie-consent-actions';

    this.rejectBtn = document.createElement('button');
    this.rejectBtn.type = 'button';
    this.rejectBtn.className = 'cookie-consent-btn';
    this.rejectBtn.setAttribute('data-consent-action', 'denied');
    this.rejectBtn.textContent = this.getAttribute('reject-label') || DEFAULT_REJECT_LABEL;

    this.acceptBtn = document.createElement('button');
    this.acceptBtn.type = 'button';
    this.acceptBtn.className = 'cookie-consent-btn';
    this.acceptBtn.setAttribute('data-consent-action', 'granted');
    this.acceptBtn.textContent = this.getAttribute('accept-label') || DEFAULT_ACCEPT_LABEL;

    this.rejectBtn.addEventListener('click', () => {
      setConsent('denied');
      this.hide();
    });

    this.acceptBtn.addEventListener('click', () => {
      setConsent('granted');
      this.hide();
    });

    actions.appendChild(this.rejectBtn);
    actions.appendChild(this.acceptBtn);

    bar.appendChild(text);
    bar.appendChild(actions);

    this.appendChild(bar);

    this.hidden = getConsent() !== null;

    // The bar's box changes as it shows, hides or wraps; the window's height moves its top.
    const publishInset = () => {
      const inset = this.hidden ? 0 : Math.max(0, innerHeight - bar.getBoundingClientRect().top);
      document.documentElement.style.setProperty(COOKIE_CONSENT_INSET, `${Math.round(inset)}px`);
    };
    new ResizeObserver(publishInset).observe(bar);
    addEventListener('resize', publishInset);
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
    if (!this.isBuilt) return;

    if (name === 'policy-href' && this.policyLink) {
      this.policyLink.href = newValue || '/privacy';
    } else if (name === 'message' && this.messageSpan) {
      this.messageSpan.textContent = newValue || DEFAULT_MESSAGE;
    } else if (name === 'policy-label' && this.policyLink) {
      this.policyLink.textContent = newValue || DEFAULT_POLICY_LABEL;
    } else if (name === 'reject-label' && this.rejectBtn) {
      this.rejectBtn.textContent = newValue || DEFAULT_REJECT_LABEL;
    } else if (name === 'accept-label' && this.acceptBtn) {
      this.acceptBtn.textContent = newValue || DEFAULT_ACCEPT_LABEL;
    }
  }

  show(): void {
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }
}

if (typeof window !== 'undefined' && typeof customElements !== 'undefined') {
  if (!customElements.get('cookie-consent')) {
    customElements.define('cookie-consent', CookieConsentElement);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'cookie-consent': CookieConsentElement;
  }
}
