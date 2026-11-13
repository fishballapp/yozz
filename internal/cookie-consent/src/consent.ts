export type Consent = 'granted' | 'denied';

export const COOKIE_CONSENT_KEY = 'fishball.cookie-consent';
export const COOKIE_CONSENT_CHANGE_EVENT = 'cookie-consent:change';

declare global {
  interface WindowEventMap {
    [COOKIE_CONSENT_CHANGE_EVENT]: CustomEvent<Consent>;
  }
}

const getStorage = (): Storage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const getConsent = (): Consent | null => {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(COOKIE_CONSENT_KEY);
    if (raw === 'granted' || raw === 'denied') {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
};

export const setConsent = (value: Consent): void => {
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(COOKIE_CONSENT_KEY, value);
    } catch {
      // Storage access blocked or restricted (e.g. Safari private mode).
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<Consent>(COOKIE_CONSENT_CHANGE_EVENT, { detail: value }));
  }
};

export const onConsentChange = (cb: (consent: Consent) => void): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const handler = (event: WindowEventMap[typeof COOKIE_CONSENT_CHANGE_EVENT]) => {
    if (event.detail === 'granted' || event.detail === 'denied') {
      cb(event.detail);
    }
  };
  window.addEventListener(COOKIE_CONSENT_CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener(COOKIE_CONSENT_CHANGE_EVENT, handler);
  };
};
