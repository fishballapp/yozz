import { beforeEach, describe, expect, it } from 'vitest';
import {
  getDeviceSecret,
  getOrCreateDeviceSecret,
  importDeviceSecret,
  saveDeviceSecret,
} from './device-secret.ts';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('Browser device secret management', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('generates, saves, and retrieves device secret for new account', () => {
    const email = 'alice@example.com';
    const secret1 = getOrCreateDeviceSecret(email, storage);
    expect(typeof secret1).toBe('string');
    expect(secret1.length).toBeGreaterThan(10);

    const secret2 = getOrCreateDeviceSecret(email, storage);
    expect(secret2).toBe(secret1);

    const retrieved = getDeviceSecret(email, storage);
    expect(retrieved).toBe(secret1);
  });

  it('returns null on getDeviceSecret if not yet enrolled on this device', () => {
    const retrieved = getDeviceSecret('unknown@example.com', storage);
    expect(retrieved).toBeNull();
  });

  it('imports device secret successfully', () => {
    const email = 'transfer@example.com';
    const importedSecret = 'device-secret-from-qr-code-123';

    importDeviceSecret(email, importedSecret, storage);

    expect(getDeviceSecret(email, storage)).toBe(importedSecret);
  });

  it('saves device secret under case-folded email key', () => {
    const secret = 'secret-123';
    saveDeviceSecret('Bob.Jones@Example.COM', secret, storage);

    expect(getDeviceSecret('bob.jones@example.com', storage)).toBe(secret);
    expect(storage.getItem('yozz:device-secret:bob.jones@example.com')).toBe(secret);
  });
});
