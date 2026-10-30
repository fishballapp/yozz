// @vitest-environment jsdom

import { ADDRESS_RECORD_TYPE, type AddressRecord } from '@yozz.app/mail/addresses/record';
import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  session: null as { userId: string; store: RecordStore } | null,
  /** The account of every task a manager was handed. A sync's first task is its LIST, so one per sync. */
  runs: [] as string[],
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({
    run: async (account: AddressRecord) => {
      mocks.runs.push(account.address);
      return { ok: false, error: { kind: 'error', detail: 'offline' } };
    },
    close: async () => {},
    closeAll: async () => {},
    state: () => ({ status: 'closed' }),
  }),
}));
vi.mock('../threads/cache', () => ({
  createMailCache: () => ({ clear: async () => {} }),
  clearMailCache: async () => {},
}));
vi.mock('@yozz.app/mail/threads/hydrate', () => ({
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
}));

// This jsdom exposes no `localStorage`; the lock's teardown clears the device draft from it.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const ALICE = 'alice@example.com';
const BOB = 'bob@example.org';

const inbound = (address: string): AddressRecord => ({
  address,
  imap: { host: 'imap.example.com', port: 993, username: address, password: 'pw' },
  smtp: { host: 'smtp.example.com', port: 465, username: address, password: 'pw' },
});

const vaultHolding = async (addresses: readonly string[]) => {
  const { store } = fakeRecordStore();
  for (const address of addresses) {
    await store.put({
      type: ADDRESS_RECORD_TYPE,
      naturalKey: address,
      plaintext: JSON.stringify(inbound(address)),
    });
  }
  return store;
};

let hidden = false;
const setHidden = async (next: boolean) => {
  hidden = next;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

beforeEach(() => {
  mocks.runs = [];
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
});

it('a tab return syncs an address whose last sync is stale, and skips one that synced within two minutes', async () => {
  let mail: ReturnType<typeof useMail> | null = null;
  const Probe = () => {
    mail = useMail();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  mocks.session = { userId: 'user-1', store: await vaultHolding([ALICE, BOB]) };
  await act(async () =>
    root.render(
      <MailProvider>
        <Probe />
      </MailProvider>,
    ),
  );
  // Each address's first sync starts when the list loads.
  await vi.waitFor(() => expect([...mocks.runs].sort()).toEqual([ALICE, BOB]));
  await vi.waitFor(() => expect(Object.keys(mail?.syncStates ?? {}).sort()).toEqual([ALICE, BOB]));

  // Alice's sync started at 10:00; Bob's starts at 10:02, so at 10:03 only Alice is stale.
  vi.setSystemTime(new Date('2026-10-12T10:02:00Z'));
  mocks.runs = [];
  await act(() => mail?.sync(BOB) ?? Promise.resolve());
  await vi.waitFor(() => expect(mocks.runs).toEqual([BOB]));

  vi.setSystemTime(new Date('2026-10-12T10:03:00Z'));
  mocks.runs = [];
  await setHidden(true);
  await setHidden(false);
  await vi.waitFor(() => expect(mocks.runs).toEqual([ALICE]));
  // Bob's skip is an absence, so give any sync it wrongly started time to show itself.
  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
  expect(mocks.runs).toEqual([ALICE]);

  await act(async () => root.unmount());
});
