import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import { senderKeyOf } from '@yozz.app/mail/threads/thread';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { describe, expect, it } from 'vitest';
import {
  forgetConsent,
  forgetSender,
  hasConsent,
  IMAGE_CONSENTS_RECORD_TYPE,
  IMAGE_SENDER_RECORD_TYPE,
  isLoadedByTrust,
  listTrustedSenders,
  MAX_REMEMBERED_CONSENTS,
  readConsents,
  rememberConsent,
  trustSender,
  withConsent,
} from './remote-images';

/** What a recovery would write; none of these tests makes the stored list unreadable. */
const unread = (): never => {
  throw new Error('the stored list was readable');
};

const consent = (n: number, sender = 'news@sender.example') => ({
  messageId: `mid/<${n}@sender.example>`,
  sender,
});

describe('withConsent', () => {
  it('keeps one entry per message and sender, newest last', () => {
    const consents = [consent(1), consent(2), consent(1, 'other@else.example')].reduce(
      withConsent,
      [],
    );
    expect(withConsent(consents, consent(1))).toEqual([
      consent(2),
      consent(1, 'other@else.example'),
      consent(1),
    ]);
  });

  it('forgets the oldest past the bound', () => {
    const consents = Array.from({ length: MAX_REMEMBERED_CONSENTS + 5 }, (_, n) =>
      consent(n),
    ).reduce(withConsent, []);
    expect(consents).toHaveLength(MAX_REMEMBERED_CONSENTS);
    expect(hasConsent(consents, consent(4))).toBe(false);
    expect(hasConsent(consents, consent(5))).toBe(true);
  });

  it('matches a sender case-insensitively, and the message exactly', () => {
    const consents = [consent(1)];
    expect(hasConsent(consents, consent(1, 'News@Sender.EXAMPLE'))).toBe(true);
    expect(hasConsent(consents, { ...consent(1), messageId: 'mid/<1@SENDER.example>' })).toBe(
      false,
    );
    expect(hasConsent(consents, consent(1, 'news+x@sender.example'))).toBe(false);
  });
});

describe('rememberConsent', () => {
  it('creates the record, then adds to it', async () => {
    const { store } = fakeRecordStore();
    await rememberConsent(store, consent(1), unread);
    await rememberConsent(store, consent(2), unread);
    expect((await readConsents(store)).consents).toEqual([consent(1), consent(2)]);
  });

  it("re-reads and keeps the other device's consent when its write landed first", async () => {
    const { store } = fakeRecordStore();
    await rememberConsent(store, consent(1), unread);
    let isRacing = true;
    const racing: RecordStore = {
      ...store,
      put: async input => {
        if (isRacing) {
          isRacing = false;
          // The phone consents between this tab's read and its write.
          await rememberConsent(store, consent(2), unread);
        }
        return store.put(input);
      },
    };
    await rememberConsent(racing, consent(3), unread);
    expect((await readConsents(store)).consents).toEqual([consent(1), consent(2), consent(3)]);
  });

  it('gives up after a few refusals and on anything that is not one', async () => {
    const { store } = fakeRecordStore();
    const refusing: RecordStore = {
      ...store,
      put: async () => {
        throw new VaultApiError('CONFLICT', 'stale', 409);
      },
    };
    await expect(rememberConsent(refusing, consent(1), unread)).rejects.toThrow('stale');
    const offline: RecordStore = {
      ...store,
      put: async () => {
        throw new TypeError('Failed to fetch');
      },
    };
    await expect(rememberConsent(offline, consent(1), unread)).rejects.toThrow('Failed to fetch');
  });

  it('reads an unreadable record as nothing remembered', async () => {
    const { store, rows, key } = fakeRecordStore();
    rows.set(key(IMAGE_CONSENTS_RECORD_TYPE, 'consents'), { plaintext: '{', revision: 1 });
    expect(await readConsents(store)).toEqual({ consents: [], revision: 1 });
    await rememberConsent(store, consent(1), unread);
    expect((await readConsents(store)).consents).toEqual([consent(1)]);
  });
});

describe('forgetConsent', () => {
  it('forgets that message alone, and keeps what another device added meanwhile', async () => {
    const { store } = fakeRecordStore();
    for (const n of [1, 2]) await rememberConsent(store, consent(n), unread);
    let isRacing = true;
    const racing: RecordStore = {
      ...store,
      put: async input => {
        if (isRacing) {
          isRacing = false;
          await rememberConsent(store, consent(3), unread);
        }
        return store.put(input);
      },
    };
    // Matched as a consent is: the sender's case does not matter.
    await forgetConsent(racing, consent(1, 'NEWS@sender.example'), unread);
    expect((await readConsents(store)).consents).toEqual([consent(2), consent(3)]);
  });
});

describe('trusted senders', () => {
  it('stores one record per address, keyed case-insensitively, and forgets it', async () => {
    const { store } = fakeRecordStore();
    await trustSender(store, { address: 'News@Sender.example', addedAt: 2, isVerifiedOnly: true });
    await trustSender(store, { address: 'first@a.example', addedAt: 1, isVerifiedOnly: true });
    await trustSender(store, { address: 'news@sender.EXAMPLE', addedAt: 3, isVerifiedOnly: true });
    expect(await listTrustedSenders(store)).toEqual([
      { address: 'first@a.example', addedAt: 1, isVerifiedOnly: true },
      { address: 'News@Sender.example', addedAt: 2, isVerifiedOnly: true },
    ]);
    await forgetSender(store, 'NEWS@sender.example');
    expect((await listTrustedSenders(store)).map(sender => senderKeyOf(sender.address))).toEqual([
      'first@a.example',
    ]);
  });

  it('reads a record written before unverified trust existed as verified-only', async () => {
    const { store } = fakeRecordStore();
    await store.put({
      type: IMAGE_SENDER_RECORD_TYPE,
      naturalKey: 'news@sender.example',
      plaintext: JSON.stringify({ address: 'news@sender.example', addedAt: 1 }),
    });
    expect(await listTrustedSenders(store)).toEqual([
      { address: 'news@sender.example', addedAt: 1, isVerifiedOnly: true },
    ]);
  });

  it('widens a verified-only trust when the address is trusted again through the warning', async () => {
    const { store } = fakeRecordStore();
    await trustSender(store, { address: 'news@sender.example', addedAt: 1, isVerifiedOnly: true });
    await trustSender(store, { address: 'News@sender.example', addedAt: 2, isVerifiedOnly: false });
    expect(await listTrustedSenders(store)).toEqual([
      { address: 'News@sender.example', addedAt: 2, isVerifiedOnly: false },
    ]);
  });

  it('keeps a wider trust when a device that has not seen it trusts the address verified-only', async () => {
    const { store } = fakeRecordStore();
    await trustSender(store, { address: 'news@sender.example', addedAt: 1, isVerifiedOnly: false });
    const held = await trustSender(store, {
      address: 'news@sender.example',
      addedAt: 2,
      isVerifiedOnly: true,
    });
    const kept = { address: 'news@sender.example', addedAt: 1, isVerifiedOnly: false };
    expect(held).toEqual(kept);
    expect(await listTrustedSenders(store)).toEqual([kept]);
  });
});

describe('isLoadedByTrust', () => {
  const sender = (isVerifiedOnly: boolean) => ({
    address: 'news@sender.example',
    addedAt: 1,
    isVerifiedOnly,
  });
  const VERIFIED = { status: 'verified' } as const;
  const UNCHECKED = { status: 'unchecked', imapHost: 'imap.example.org' } as const;
  const FAILED = { status: 'failed' } as const;

  it('loads nothing from a sender nobody trusted', () => {
    expect(isLoadedByTrust(undefined, VERIFIED)).toBe(false);
  });

  it('loads only verified messages under a verified-only trust', () => {
    expect(isLoadedByTrust(sender(true), VERIFIED)).toBe(true);
    expect(isLoadedByTrust(sender(true), UNCHECKED)).toBe(false);
    expect(isLoadedByTrust(sender(true), FAILED)).toBe(false);
    expect(isLoadedByTrust(sender(true), undefined)).toBe(false);
  });

  it('loads every message showing the address under a trust given through the warning', () => {
    for (const check of [VERIFIED, UNCHECKED, FAILED, undefined]) {
      expect(isLoadedByTrust(sender(false), check)).toBe(true);
    }
  });
});
