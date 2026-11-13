// Store-only root entry. The custom element lives at `@internal/cookie-consent/element`, so
// importing `getConsent` on the server never evaluates `class … extends HTMLElement`.
export * from './consent.ts';
