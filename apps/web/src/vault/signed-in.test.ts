import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { hasAnyUnlockKeys, isSignedInCookieSet } from './signed-in';
import { forgetUnlockKeys, saveUnlockKeys } from './unlock-keys';

describe('isSignedInCookieSet', () => {
  it('finds the cookie among others', () => {
    expect(isSignedInCookieSet('a=1; yozz-signed-in=1; b=2')).toBe(true);
    expect(isSignedInCookieSet('yozz-signed-in=1')).toBe(true);
  });

  it('is false with no header, a cleared cookie, or a name it merely ends', () => {
    expect(isSignedInCookieSet(null)).toBe(false);
    expect(isSignedInCookieSet('yozz-signed-in=')).toBe(false);
    expect(isSignedInCookieSet('not-yozz-signed-in=1')).toBe(false);
  });
});

describe('hasAnyUnlockKeys', () => {
  it('is false on a device that never opened YOZZ, and creates no database there', async () => {
    const idbFactory = new IDBFactory();
    expect(await hasAnyUnlockKeys(idbFactory)).toBe(false);
    expect(await idbFactory.databases()).toEqual([]);
  });

  it('is true while keys are saved, and false once they are forgotten', async () => {
    const idbFactory = new IDBFactory();
    const encKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'wrapKey',
    ]);
    await saveUnlockKeys(
      { userId: 'u1', mode: 'password', encKey, wrappedDek: 'w', stamp: 's' },
      idbFactory,
    );
    expect(await hasAnyUnlockKeys(idbFactory)).toBe(true);
    await forgetUnlockKeys('u1', idbFactory);
    expect(await hasAnyUnlockKeys(idbFactory)).toBe(false);
  });
});
