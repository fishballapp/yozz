import { createDeviceSecret, foldEmail } from '@yozz.app/vault';

export class DeviceStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceStorageError';
  }
}

export class DeviceSecretMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceSecretMissingError';
  }
}

const storageKey = (email: string): string => `yozz:device-secret:${foldEmail(email)}`;

const getStorage = (storage?: Storage): Storage => {
  if (storage) return storage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  throw new DeviceStorageError('localStorage is not available in this environment');
};

export const getDeviceSecret = (email: string, storage?: Storage): string | null => {
  try {
    const store = getStorage(storage);
    const key = storageKey(email);
    const secret = store.getItem(key);
    if (!secret || secret.trim().length === 0) {
      return null;
    }
    return secret.trim();
  } catch (err) {
    if (err instanceof DeviceStorageError) throw err;
    throw new DeviceStorageError(`Failed to read device secret from storage: ${String(err)}`);
  }
};

export const saveDeviceSecret = (email: string, secret: string, storage?: Storage): void => {
  try {
    const store = getStorage(storage);
    const key = storageKey(email);
    store.setItem(key, secret.trim());
  } catch (err) {
    if (err instanceof DeviceStorageError) throw err;
    throw new DeviceStorageError(`Failed to save device secret to storage: ${String(err)}`);
  }
};

export const getOrCreateDeviceSecret = (email: string, storage?: Storage): string => {
  const existing = getDeviceSecret(email, storage);
  if (existing) {
    return existing;
  }
  const created = createDeviceSecret();
  saveDeviceSecret(email, created, storage);
  return created;
};

export const importDeviceSecret = (email: string, secret: string, storage?: Storage): void => {
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new DeviceStorageError('Cannot import empty device secret');
  }
  saveDeviceSecret(email, secret, storage);
};
