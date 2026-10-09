// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS_RECORD_TYPE, type AddressRecord, parseAddressRecord } from '../addresses/record';
import type { LiveState } from '../relay/live';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import type { UnlockedVaultSession } from '../vault/unlock';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A sync that runs until the test finishes it, with the `isStale` it was handed. */
type HeldSync = { isStale: () => boolean; finish: () => void };

const mocks = vi.hoisted(() => ({
  session: null as Pick<UnlockedVaultSession, 'userId' | 'store'> | null,
  syncs: [] as HeldSync[],
  /** What reached the vault and the device cache, in order. */
  events: [] as string[],
  /** Counts live managers, one per session, so a close says whose connection it was. */
  managers: 0,
  /** Each manager's state report, by manager number, so a test can report for an ended session. */
  reportState: [] as ((address: string, state: LiveState) => void)[],
  closeLive: vi.fn(async (_manager: number, _address: string) => {}),
  composer: {
    slice: {},
    load: async () => {},
    reset: () => {},
    drafts: [],
    vaultSent: [],
  },
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('./use-composer', () => ({ useComposer: () => mocks.composer }));
vi.mock('../relay/live', () => ({
  createLiveManager: ({ onState }: { onState: (address: string, state: LiveState) => void }) => {
    mocks.managers += 1;
    const manager = mocks.managers;
    mocks.reportState[manager] = onState;
    return {
      run: async () => ({ ok: false, error: { kind: 'error', detail: 'not in this test' } }),
      close: (address: string) => mocks.closeLive(manager, address),
      closeAll: async () => {},
      setVisible: () => {},
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
vi.mock('../threads/sync', () => ({
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
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

const record = (address: string, senderName: string): AddressRecord => ({
  address,
  senderName,
  imap: { host: 'imap.example.com', port: 993, username: address, password: 'pw' },
  smtp: { host: 'smtp.example.com', port: 465, username: address, password: 'pw' },
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
    await vi.waitFor(() => expect(mocks.syncs).toHaveLength(1));

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
    // The sync that was running when the removal began still writes what it fetches.
    expect(mocks.syncs[0]?.isStale()).toBe(false);
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

  it("a connection of an ended session cannot report into the next session's live state", async () => {
    const { mail, replaceSession } = await mount(await vaultWith([ALICE]));
    await replaceSession({ userId: 'user-2', store: await vaultWith([ALICE]) });

    await act(async () => mocks.reportState[1]?.(ALICE.address, { status: 'closed' }));
    expect(mail().liveStates[ALICE.address]).toBeUndefined();
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
      await expect(readding).rejects.toThrow('locked');
    });
    expect(mocks.events).toEqual([`clear user-1 ${ALICE.address}`]);
    expect(addressesOf(mail())).toEqual([BOB.address]);
  });
});
