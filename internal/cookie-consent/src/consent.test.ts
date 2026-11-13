import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_CONSENT_KEY, getConsent, onConsentChange, setConsent } from './consent';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, String(value));
  }
}

describe('consent store', () => {
  let memoryStorage: MemoryStorage;
  let mockWindow: Record<string, unknown>;

  beforeEach(() => {
    memoryStorage = new MemoryStorage();
    const listeners: Record<string, EventListenerOrEventListenerObject[]> = {};

    mockWindow = {
      get localStorage() {
        return memoryStorage;
      },
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(listener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter(l => l !== listener);
      },
      dispatchEvent: (event: Event) => {
        const list = listeners[event.type] || [];
        for (const l of list) {
          if (typeof l === 'function') {
            l(event);
          } else if (l && typeof l.handleEvent === 'function') {
            l.handleEvent(event);
          }
        }
        return true;
      },
    };

    (globalThis as unknown as { window: unknown }).window = mockWindow;
    (globalThis as unknown as { localStorage: unknown }).localStorage = memoryStorage;
    vi.restoreAllMocks();
  });

  it('performs get/set round-trip for granted and denied', () => {
    expect(getConsent()).toBeNull();

    setConsent('granted');
    expect(getConsent()).toBe('granted');
    expect(memoryStorage.getItem(COOKIE_CONSENT_KEY)).toBe('granted');

    setConsent('denied');
    expect(getConsent()).toBe('denied');
    expect(memoryStorage.getItem(COOKIE_CONSENT_KEY)).toBe('denied');
  });

  it('stores nothing until the visitor chooses', () => {
    expect(getConsent()).toBeNull();
    onConsentChange(() => {});

    expect(memoryStorage.length).toBe(0);
  });

  it('returns null for invalid stored values', () => {
    memoryStorage.setItem(COOKIE_CONSENT_KEY, 'unknown_value');
    expect(getConsent()).toBeNull();

    memoryStorage.setItem(COOKIE_CONSENT_KEY, '');
    expect(getConsent()).toBeNull();

    memoryStorage.setItem(COOKIE_CONSENT_KEY, 'TRUE');
    expect(getConsent()).toBeNull();
  });

  it('fires change event and unsubscribes properly', () => {
    const callback = vi.fn();
    const unsubscribe = onConsentChange(callback);

    setConsent('granted');
    expect(callback).toHaveBeenCalledWith('granted');
    expect(callback).toHaveBeenCalledTimes(1);

    setConsent('denied');
    expect(callback).toHaveBeenCalledWith('denied');
    expect(callback).toHaveBeenCalledTimes(2);

    unsubscribe();
    setConsent('granted');
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('handles storage that throws without crashing and returns null', () => {
    vi.spyOn(memoryStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: The operation is insecure.');
    });

    expect(getConsent()).toBeNull();

    vi.spyOn(memoryStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => setConsent('granted')).not.toThrow();
  });

  it('handles window.localStorage getter throwing without crashing', () => {
    Object.defineProperty(mockWindow, 'localStorage', {
      get() {
        throw new Error('SecurityError: Storage access is denied');
      },
    });

    expect(getConsent()).toBeNull();
    expect(() => setConsent('granted')).not.toThrow();
  });
});
