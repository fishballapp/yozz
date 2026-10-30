// @vitest-environment jsdom

import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  parseAddressRecord,
} from '@yozz.app/mail/addresses/record';
import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveState } from '../relay/live';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A sync that runs until the test finishes it, with the `isStale` it was handed. */
type HeldSync = { isStale: () => boolean; finish: () => void };

const mocks = vi.hoisted(() => ({
  // What the mail store reads of the session.
  session: null as { readonly userId: string; readonly store: RecordStore } | null,
  syncs: [] as HeldSync[],
  /** What reached the vault and the device cache, in order. */
  events: [] as string[],
  /** Counts live managers, one per session, so a close says whose connection it was. */
  managers: 0,
  /** Each manager's state report, by manager number, so a test can report for an ended session. */
  reportState: [] as ((address: string, state: LiveState) => void)[],
  closeLive: vi.fn(async (_manager: number, _address: string) => {}),
  composer: {
    composer: {},
    shared: { drafts: [] },
    load: async () => {},
    reset: () => {},
    vaultSent: [],
  },
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('./use-composer', () => ({ useComposerStore: () => mocks.composer }));
vi.mock('../relay/live', () => ({
  createLiveManager: ({ onState }: { onState: (address: string, state: LiveState) => void }) => {
    mocks.managers += 1;
    const manager = mocks.managers;
    mocks.reportState[manager] = onState;
    return {
      run: async () => ({ ok: false, error: { kind: 'error', detail: 'not in this test' } }),
      close: (address: string) => mocks.closeLive(manager, address),
      closeAll: async () => {},
      state: () => ({ status: 'closed' }),
    };
  },
}));
vi.mock('../threads/cache', () => ({
  createMailCache: (userId: string, address: string) => ({
    clear: async () => {
      mocks.events.push(`clear ${userId} ${address}`);
    },
  }),
  clearMailCache: async () => {},
}));
vi.mock('@yozz.app/mail/threads/hydrate', () => ({
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
}));
vi.mock('@yozz.app/mail/threads/sync', () => ({
  prefetchBodies: () => {},
  syncAccount: (_run: unknown, _cache: unknown, isStale: () => boolean) =>
    new Promise(resolve => {
      mocks.syncs.push({
        isStale,
        finish: () =>
          resolve({
            byFolder: {},
            state: { status: 'failed', failure: { kind: 'error', detail: 'done' }, at: 0 },
          }),
      });
    }),
}));

const record = (
  address: string,
  senderName: string,
  imap: Partial<NonNullable<AddressRecord['imap']>> = {},
  smtp: Partial<AddressRecord['smtp']> = {},
): AddressRecord => ({
  address,
  senderName,
  imap: { host: 'imap.example.com', port: 993, username: address, password: 'pw', ...imap },
  smtp: { host: 'smtp.example.com', port: 465, username: address, password: 'pw', ...smtp },
});
const ALICE = record('alice@example.com', 'Alice');
const BOB = record('bob@example.com', 'Bob');
/** Alice added back, told apart by the name it carries. */
const RENAMED_ALICE = record(ALICE.address, 'Al');

/** A vault call that waits for the test to settle it. */
const held = () => {
  const calls: PromiseWithResolvers<void>[] = [];
  return {
    calls,
    call: () => {
      const call = Promise.withResolvers<void>();
      calls.push(call);
      return call.promise;
    },
  };
};

const vaultWith = async (records: readonly AddressRecord[]) => {
  const { store } = fakeRecordStore();
  for (const stored of records) {
    await store.put({
      type: ADDRESS_RECORD_TYPE,
      naturalKey: stored.address,
      plaintext: JSON.stringify(stored),
    });
  }
  return store;
};

/** A store's writes, logged into `events` as they land; the delete first waits on `deleted`. */
const logged = (store: RecordStore, deleted: () => Promise<void> = async () => {}) => ({
  put: async (input: Parameters<RecordStore['put']>[0]) => {
    mocks.events.push(`put ${input.naturalKey}`);
    await store.put(input);
  },
  remove: async (type: string, naturalKey: string) => {
    await deleted();
    mocks.events.push(`remove ${naturalKey}`);
    await store.remove(type, naturalKey);
  },
});

const storedNames = (rows: readonly { plaintext: string }[]) =>
  rows.map(row => parseAddressRecord(row.plaintext)?.senderName);

const unmounts: (() => Promise<void>)[] = [];

const mount = async (store: RecordStore) => {
  mocks.session = { userId: 'user-1', store };
  let mail: ReturnType<typeof useMail> | null = null;
  const Probe = () => {
    mail = useMail();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const render = () =>
    act(async () =>
      root.render(
        <MailProvider>
          <Probe />
        </MailProvider>,
      ),
    );
  await render();
  unmounts.push(() => act(async () => root.unmount()));
  const current = () => {
    if (mail === null) throw new Error('MailProvider did not render');
    return mail;
  };
  await vi.waitFor(() => expect(current().identities).not.toHaveLength(0));
  return {
    mail: current,
    /** A lock and unlock, or a sign-in as another account: the provider tears one session down for the next. */
    replaceSession: async (session: NonNullable<typeof mocks.session>) => {
      mocks.session = session;
      await render();
    },
  };
};

const addressesOf = (mail: ReturnType<typeof useMail>) =>
  mail.identities.map(identity => identity.address);
const nameOf = (mail: ReturnType<typeof useMail>, address: string) =>
  mail.identities.find(identity => identity.address === address)?.senderName;

beforeEach(() => {
  mocks.syncs.length = 0;
  mocks.events.length = 0;
  mocks.managers = 0;
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  mocks.session = null;
  vi.clearAllMocks();
});

describe('setSenderName', () => {
  it('shows the new name before the vault has it, and the old one again when the vault refuses', async () => {
    const put = held();
    const { mail } = await mount({ ...(await vaultWith([ALICE])), put: put.call });

    let renaming = Promise.resolve();
    act(() => {
      renaming = mail().setSenderName(ALICE.address, '  Al  ');
    });
    expect(nameOf(mail(), ALICE.address)).toBe('Al');

    await act(async () => {
      put.calls[0]?.reject(new Error('offline'));
      await expect(renaming).rejects.toThrow('offline');
    });
    expect(nameOf(mail(), ALICE.address)).toBe('Alice');
  });

  it('a refused rename leaves a later one on screen', async () => {
    const put = held();
    const { mail } = await mount({ ...(await vaultWith([ALICE])), put: put.call });

    let first = Promise.resolve();
    act(() => {
      first = mail().setSenderName(ALICE.address, 'Al');
    });
    act(() => {
      void mail().setSenderName(ALICE.address, 'Ally');
    });

    await act(async () => {
      put.calls[0]?.reject(new Error('offline'));
      await expect(first).rejects.toThrow('offline');
    });
    expect(nameOf(mail(), ALICE.address)).toBe('Ally');
  });
});

describe('removeAddress', () => {
  it('keeps the address until the vault deletes it, so a refusal changes nothing', async () => {
    const remove = held();
    const { mail } = await mount({ ...(await vaultWith([ALICE, BOB])), remove: remove.call });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));

    let removing = Promise.resolve();
    act(() => {
      removing = mail().removeAddress(ALICE.address);
    });
    expect(addressesOf(mail())).toEqual([ALICE.address, BOB.address]);

    await act(async () => {
      remove.calls[0]?.reject(new Error('offline'));
      await expect(removing).rejects.toThrow('offline');
    });
    expect(addressesOf(mail())).toEqual([ALICE.address, BOB.address]);
    // The syncs that were running when the removal began still write what they fetch.
    expect(mocks.syncs.map(sync => sync.isStale())).toEqual([false, false]);
    expect(mocks.closeLive).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('resolves at the vault delete, and clears the cache only once the running sync has finished', async () => {
    const store = await vaultWith([ALICE]);
    const { mail } = await mount(store);
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));
    const [running] = mocks.syncs;

    await act(() => mail().removeAddress(ALICE.address));
    expect(await store.list(ADDRESS_RECORD_TYPE)).toEqual([]);
    expect(addressesOf(mail())).toEqual([]);
    expect(running?.isStale()).toBe(true);
    expect(mocks.closeLive).toHaveBeenCalledWith(1, ALICE.address);
    expect(mocks.events).toEqual([]);

    await act(async () => running?.finish());
    await vi.waitFor(() => expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]));
    // The finishing sync reported its state; the teardown drops it after.
    expect(mail().syncStates).not.toHaveProperty(ALICE.address);
  });

  it('adding the address back waits for its cache to be cleared', async () => {
    const store = await vaultWith([ALICE]);
    const { mail } = await mount({ ...store, put: logged(store).put });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    await act(() => mail().removeAddress(ALICE.address));
    let readding = Promise.resolve();
    act(() => {
      readding = mail().putAddress(ALICE);
    });
    await act(async () => mocks.syncs[0]?.finish());
    await act(() => readding);

    expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`, `put ${ALICE.address}`]);
    expect(addressesOf(mail())).toEqual([ALICE.address]);
  });

  it('adding the address back while the vault deletes it is stored after the delete and the teardown', async () => {
    const store = await vaultWith([ALICE]);
    const remove = held();
    const { mail } = await mount({ ...store, ...logged(store, remove.call) });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    let removing = Promise.resolve();
    let readding = Promise.resolve();
    await act(async () => {
      removing = mail().removeAddress(ALICE.address);
      readding = mail().putAddress(RENAMED_ALICE);
    });
    expect(mocks.events).toEqual([]);

    await act(async () => {
      remove.calls[0]?.resolve();
      await removing;
    });
    expect(mocks.events).toEqual([`remove ${ALICE.address}`]);

    await act(async () => {
      mocks.syncs[0]?.finish();
      await readding;
    });
    expect(mocks.events).toEqual([
      `remove ${ALICE.address}`,
      `clear user-1 ${ALICE.address}`,
      `put ${ALICE.address}`,
    ]);
    expect(storedNames(await store.list(ADDRESS_RECORD_TYPE))).toEqual(['Al']);
    expect(mail().identities).toEqual([RENAMED_ALICE]);
  });

  it('adding the address back while the vault refuses to delete it replaces the old record', async () => {
    const store = await vaultWith([ALICE]);
    const remove = held();
    const { mail } = await mount({ ...store, ...logged(store, remove.call) });

    let removing = Promise.resolve();
    let readding = Promise.resolve();
    await act(async () => {
      removing = mail().removeAddress(ALICE.address);
      readding = mail().putAddress(RENAMED_ALICE);
    });
    expect(mocks.events).toEqual([]);

    await act(async () => {
      remove.calls[0]?.reject(new Error('offline'));
      await expect(removing).rejects.toThrow('offline');
      await readding;
    });
    expect(mocks.events).toEqual([`put ${ALICE.address}`]);
    expect(storedNames(await store.list(ADDRESS_RECORD_TYPE))).toEqual(['Al']);
    expect(mail().identities).toEqual([RENAMED_ALICE]);
  });

  it('a delete answered after the session changed leaves the next session alone', async () => {
    const remove = held();
    const { mail, replaceSession } = await mount({
      ...(await vaultWith([ALICE])),
      remove: remove.call,
    });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    let removing = Promise.resolve();
    act(() => {
      removing = mail().removeAddress(ALICE.address);
    });
    await replaceSession({ userId: 'user-2', store: await vaultWith([ALICE]) });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));

    await act(async () => {
      remove.calls[0]?.resolve();
      await removing;
    });
    await act(async () => mocks.syncs[0]?.finish());
    expect(addressesOf(mail())).toEqual([ALICE.address]);
    expect(mocks.syncs[1]?.isStale()).toBe(false);
    expect(mail().syncStates[ALICE.address]).toEqual({ status: 'syncing' });
    expect(mocks.closeLive).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('a teardown that outlives its session leaves the next session alone', async () => {
    const { mail, replaceSession } = await mount(await vaultWith([ALICE]));
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    await act(() => mail().removeAddress(ALICE.address));
    await replaceSession({ userId: 'user-2', store: await vaultWith([ALICE]) });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));

    await act(async () => mocks.syncs[0]?.finish());
    await vi.waitFor(() => expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]));
    await act(async () => {});
    expect(mocks.closeLive.mock.calls).toEqual([[1, ALICE.address]]);
    expect(mail().syncStates[ALICE.address]).toEqual({ status: 'syncing' });
  });

  it("a removal answered after its session ended leaves the next session's removal in force", async () => {
    const remove = held();
    const { mail, replaceSession } = await mount({
      ...(await vaultWith([ALICE])),
      remove: remove.call,
    });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));
    let first = Promise.resolve();
    act(() => {
      first = mail().removeAddress(ALICE.address);
    });
    const next = await vaultWith([ALICE]);
    await replaceSession({ userId: 'user-2', store: { ...next, put: logged(next).put } });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));

    await act(() => mail().removeAddress(ALICE.address));
    await act(async () => {
      remove.calls[0]?.resolve();
      await first;
    });
    let readding = Promise.resolve();
    act(() => {
      readding = mail().putAddress(ALICE);
    });
    await act(async () => {});
    expect(mocks.events).toEqual([]);

    await act(async () => {
      mocks.syncs[1]?.finish();
      await readding;
    });
    expect(mocks.events).toEqual([`clear user-2 ${ALICE.address}`, `put ${ALICE.address}`]);
  });

  it('adding the address back stores nothing once its session has ended', async () => {
    const store = await vaultWith([ALICE]);
    const { mail, replaceSession } = await mount({ ...store, put: logged(store).put });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    await act(() => mail().removeAddress(ALICE.address));
    let readding = Promise.resolve();
    act(() => {
      readding = mail().putAddress(ALICE);
    });
    await replaceSession({ userId: 'user-2', store: await vaultWith([BOB]) });
    await vi.waitFor(() => expect(addressesOf(mail())).toEqual([BOB.address]));

    await act(async () => {
      mocks.syncs[0]?.finish();
      await expect(readding).rejects.toThrow('signed out');
    });
    expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]);
    expect(addressesOf(mail())).toEqual([BOB.address]);
  });
});

describe('replaceAddress', () => {
  /**
   * A removal's teardown (close, the old sync's end, the cache clear) runs on after the call
   * returns. A test that removes waits for its clear, so it cannot land in the next test's events.
   */
  const removalTeardown = async () => {
    await act(async () => mocks.syncs[0]?.finish());
    await vi.waitFor(() => expect(mocks.events).toContain(`clear user-1 ${ALICE.address}`));
  };

  const edited = (imap: Parameters<typeof record>[2], smtp?: Parameters<typeof record>[3]) =>
    record(ALICE.address, 'Alice', imap, smtp);

  it('a new password closes the connection and keeps the cache, and syncs again once the old run has ended', async () => {
    const store = await vaultWith([ALICE]);
    const { mail } = await mount(store);
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));
    const [running] = mocks.syncs;
    const next = edited({ password: 'new' });

    await act(() => mail().replaceAddress(next));
    expect(mail().identities).toEqual([next]);
    expect((await store.list(ADDRESS_RECORD_TYPE)).map(row => row.plaintext)).toEqual([
      JSON.stringify(next),
    ]);
    // The old run logs in as the old record no more, and the new one waits for it to end.
    expect(running?.isStale()).toBe(true);
    expect(mocks.closeLive).toHaveBeenCalledWith(1, ALICE.address);
    expect(mocks.syncs).toHaveLength(1);

    await act(async () => running?.finish());
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));
    expect(mocks.syncs[1]?.isStale()).toBe(false);
    expect(mocks.events).toEqual([]);
  });

  it('a new IMAP host clears what was cached for the address, once the old run has ended and before the next sync', async () => {
    const { mail } = await mount(await vaultWith([ALICE, BOB]));
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));
    const [running] = mocks.syncs;

    await act(() => mail().replaceAddress(edited({ host: 'imap.other.example' })));
    expect(mocks.closeLive).toHaveBeenCalledWith(1, ALICE.address);
    expect(mocks.events).toEqual([]);
    expect(mocks.syncs).toHaveLength(2);

    await act(async () => running?.finish());
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(3));
    expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]);
    expect(mocks.syncs[2]?.isStale()).toBe(false);
    // Bob's mail is another address's, and stays.
    expect(mocks.syncs[1]?.isStale()).toBe(false);
  });

  it('a new login clears the cache as a new host does', async () => {
    const { mail } = await mount(await vaultWith([ALICE]));
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    await act(() => mail().replaceAddress(edited({ username: 'someone-else' })));
    await act(async () => mocks.syncs[0]?.finish());
    await vi.waitFor(() => expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]));
  });

  it('a new SMTP server leaves the connection and the cache alone', async () => {
    const { mail } = await mount(await vaultWith([ALICE]));
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));
    const next = edited({}, { host: 'smtp.other.example' });

    await act(() => mail().replaceAddress(next));
    expect(mail().identities).toEqual([next]);
    expect(mocks.syncs[0]?.isStale()).toBe(false);
    expect(mocks.closeLive).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('a refusal by the vault changes nothing', async () => {
    const put = held();
    const { mail } = await mount({ ...(await vaultWith([ALICE])), put: put.call });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    let replacing = Promise.resolve();
    act(() => {
      replacing = mail().replaceAddress(edited({ host: 'imap.other.example' }));
    });
    // Nothing shows before the vault has it.
    expect(mail().identities).toEqual([ALICE]);

    await act(async () => {
      put.calls[0]?.reject(new Error('offline'));
      await expect(replacing).rejects.toThrow('offline');
    });
    expect(mail().identities).toEqual([ALICE]);
    expect(mocks.syncs[0]?.isStale()).toBe(false);
    expect(mocks.closeLive).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('a lock while the vault writes shows and clears nothing in the next session', async () => {
    const put = held();
    const { mail, replaceSession } = await mount({
      ...(await vaultWith([ALICE])),
      put: put.call,
    });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

    let replacing = Promise.resolve();
    act(() => {
      replacing = mail().replaceAddress(edited({ host: 'imap.other.example' }));
    });
    await replaceSession({ userId: 'user-2', store: await vaultWith([ALICE]) });
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(2));

    await act(async () => {
      put.calls[0]?.resolve();
      await replacing;
    });
    expect(mail().identities).toEqual([ALICE]);
    expect(mocks.syncs[1]?.isStale()).toBe(false);
    expect(mocks.closeLive).not.toHaveBeenCalled();
    expect(mocks.events).toEqual([]);
  });

  it('refuses an edit once the removal of the address has begun, before writing anything', async () => {
    const store = await vaultWith([ALICE, BOB]);
    const remove = held();
    const { mail } = await mount({ ...store, ...logged(store, remove.call) });

    let removing = Promise.resolve();
    act(() => {
      removing = mail().removeAddress(ALICE.address);
    });
    await act(async () => {
      await expect(mail().replaceAddress(edited({ password: 'new' }))).rejects.toThrow('removed');
    });
    expect(mocks.events).toEqual([]);

    await act(async () => {
      remove.calls[0]?.resolve();
      await removing;
    });
    expect(storedNames(await store.list(ADDRESS_RECORD_TYPE))).toEqual(['Bob']);
    await removalTeardown();
  });

  it('refuses an edit of an address that has been removed', async () => {
    const store = await vaultWith([ALICE, BOB]);
    const { mail } = await mount({ ...store, put: logged(store).put });

    await act(() => mail().removeAddress(ALICE.address));
    await act(async () => {
      await expect(mail().replaceAddress(edited({ password: 'new' }))).rejects.toThrow('removed');
    });
    expect(mocks.events).not.toContain(`put ${ALICE.address}`);
    expect(storedNames(await store.list(ADDRESS_RECORD_TYPE))).toEqual(['Bob']);
    await removalTeardown();
  });

  it('a removal begun while an edit is being written is deleted after the write, so the address stays gone', async () => {
    const store = await vaultWith([ALICE, BOB]);
    const put = held();
    const { mail } = await mount({
      ...store,
      put: async input => {
        mocks.events.push(`put ${input.naturalKey}`);
        await put.call();
        await store.put(input);
      },
      remove: async (type: string, key: string) => {
        mocks.events.push(`remove ${key}`);
        await store.remove(type, key);
      },
    });

    let replacing = Promise.resolve();
    let removing = Promise.resolve();
    act(() => {
      replacing = mail().replaceAddress(edited({ password: 'new' }));
    });
    act(() => {
      removing = mail().removeAddress(ALICE.address);
    });
    await act(async () => {});
    expect(mocks.events).toEqual([`put ${ALICE.address}`]);

    await act(async () => {
      put.calls[0]?.resolve();
      await replacing;
      await removing;
    });
    expect(mocks.events.filter(event => !event.startsWith('clear'))).toEqual([
      `put ${ALICE.address}`,
      `remove ${ALICE.address}`,
    ]);
    expect(addressesOf(mail())).toEqual([BOB.address]);
    expect(storedNames(await store.list(ADDRESS_RECORD_TYPE))).toEqual(['Bob']);
    await removalTeardown();
  });
});
