import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createIndexedDbRevisionMarks } from './revision-marks';
import { forgetUnlockKeys, loadUnlockKeys, saveUnlockKeys } from './unlock-keys';

const aesKey = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

describe('unlock keys', () => {
  it('round-trips a non-extractable key, per user, and forgets it', async () => {
    const idbFactory = new IDBFactory();
    const encKey = await aesKey();
    await saveUnlockKeys(
      { userId: 'u1', mode: 'password', encKey, wrappedDek: 'w', stamp: 's' },
      idbFactory,
    );

    const loaded = await loadUnlockKeys('u1', idbFactory);
    expect(loaded?.mode).toBe('password');
    expect(loaded?.wrappedDek).toBe('w');
    expect(loaded?.encKey.extractable).toBe(false);
    expect(await loadUnlockKeys('u2', idbFactory)).toBeNull();

    await forgetUnlockKeys('u1', idbFactory);
    expect(await loadUnlockKeys('u1', idbFactory)).toBeNull();
  });

  it('shares the database with the revision marks', async () => {
    const idbFactory = new IDBFactory();
    const marks = createIndexedDbRevisionMarks('u1', idbFactory);
    await marks.raiseTo('r', 1);
    await saveUnlockKeys(
      { userId: 'u1', mode: 'passkey', encKey: await aesKey(), wrappedDek: 'w', stamp: 's' },
      idbFactory,
    );
    expect(await marks.highWaterMark('r')).toBe(1);
    marks.close();
  });
});
