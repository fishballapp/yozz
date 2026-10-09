// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ADDRESS_RECORD_TYPE, type AddressRecord } from '../addresses/record';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import { MailProvider, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Its own file because a module loads once per file: the sync module's first load, which brings the
 * TLS stack in the app, is held here until the test lets it go.
 */
const mocks = vi.hoisted(() => ({
  session: null as { userId: string; store: RecordStore } | null,
  stack: Promise.withResolvers<void>(),
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => ({
    run: async () => ({ ok: false, error: { kind: 'error', detail: 'offline' } }),
    close: async () => {},
    closeAll: async () => {},
    setVisible: () => {},
  }),
}));
vi.mock('../threads/cache', () => ({
  createMailCache: () => ({ clear: async () => {} }),
  clearMailCache: async () => {},
}));
vi.mock('../threads/hydrate', () => ({
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
}));
vi.mock('../threads/sync', async () => {
  await mocks.stack.promise;
  return { syncAccount: () => new Promise(() => {}), prefetchBodies: () => {} };
});

// This jsdom exposes no `localStorage`; the lock's teardown clears the device draft from it.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const inbound = (address: string): AddressRecord => ({
  address,
  imap: { host: 'imap.example.com', port: 993, username: address, password: 'pw' },
  smtp: { host: 'smtp.example.com', port: 465, username: address, password: 'pw' },
});

const vaultHolding = async (address: AddressRecord) => {
  const { store } = fakeRecordStore();
  await store.put({
    type: ADDRESS_RECORD_TYPE,
    naturalKey: address.address,
    plaintext: JSON.stringify(address),
  });
  return store;
};

const unmounts: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

it("a first sync whose stack loaded after the session ended names nothing in the next session's states", async () => {
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
  unmounts.push(() => act(async () => root.unmount()));
  const states = () => Object.keys(mail?.syncStates ?? {});

  mocks.session = { userId: 'user-1', store: await vaultHolding(inbound('alice@example.com')) };
  await render();
  await vi.waitFor(() => expect(mail?.identities).toHaveLength(1));
  // Past the cached list's frame, so the sync waits on the stack alone.
  await act(() => new Promise(resolve => setTimeout(resolve, 50)));
  mocks.session = { userId: 'user-2', store: await vaultHolding(inbound('bob@example.org')) };
  await render();
  await vi.waitFor(() =>
    expect(mail?.identities.map(record => record.address)).toEqual(['bob@example.org']),
  );

  await act(async () => mocks.stack.resolve());
  await vi.waitFor(() => expect(states()).toContain('bob@example.org'));
  expect(states()).toEqual(['bob@example.org']);
});
