// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import type { ImapMessageSummary } from '@yozz.app/imap';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS_RECORD_TYPE, type AddressRecord } from '../addresses/record';
import { createMailCache } from '../threads/cache';
import type { syncAccount } from '../threads/sync';
import type { RecordStore } from '../vault/record-store';
import { MailProvider, useMail } from './MailProvider';

// The TLS stack never arrives: whatever renders below rendered without it.
vi.mock('../relay/connection', () => new Promise(() => {}));

// The module that brings the stack, whose sync runs the moment it loads. Its one task opens the
// account's connection, which then waits on `relay/connection` for ever.
const transport = vi.hoisted(() => ({
  syncAccount: vi.fn((run: Parameters<typeof syncAccount>[0]) =>
    run({ run: async () => ({ ok: true, value: undefined }), priority: 'user', retry: true }),
  ),
}));
vi.mock('../threads/sync', () => ({
  syncAccount: transport.syncAccount,
  prefetchBodies: () => {},
}));

const ADDRESS: AddressRecord = {
  address: 'me@example.com',
  smtp: { host: 'smtp.example.com', port: 465, username: 'me', password: 'secret' },
  imap: { host: 'imap.example.com', port: 993, username: 'me', password: 'secret' },
};

const store: RecordStore = {
  get: async () => null,
  list: async type =>
    type === ADDRESS_RECORD_TYPE
      ? [{ naturalKey: ADDRESS.address, revision: 1, plaintext: JSON.stringify(ADDRESS) }]
      : [],
  put: async () => {},
  remove: async () => {},
  close: () => {},
};

const vault = { session: { userId: 'u1', store } };

vi.mock('../vault/session', () => ({ useVault: () => vault }));

// This jsdom exposes no `localStorage`; the lock's teardown clears the device draft from it.
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const cachedSummary: ImapMessageSummary = {
  seq: 1,
  uid: 7,
  flags: [],
  internalDate: '23-Aug-2026 09:00:00 +0000',
  size: 1024,
  envelope: {
    date: 'Sun, 23 Aug 2026 09:00:00 +0000',
    subject: 'Quarterly numbers',
    subjectRaw: 'Quarterly numbers',
    from: [{ name: 'Alice Smith', mailbox: 'alice', host: 'example.org' }],
    sender: [],
    replyTo: [],
    to: [{ name: null, mailbox: 'me', host: 'example.com' }],
    cc: [],
    bcc: [],
    inReplyTo: null,
    messageId: '<numbers@example.org>',
  },
  references: [],
  gmailThreadId: null,
};

const Subjects = () => (
  <ul>
    {useMail().threads.map(thread => (
      <li key={thread.id}>{thread.subject}</li>
    ))}
  </ul>
);

let mail: ReturnType<typeof useMail> | null = null;
const Mail = () => {
  mail = useMail();
  return null;
};

const unmounts: Array<() => Promise<void>> = [];

const renderProvider = async (children: ReactNode) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<MailProvider>{children}</MailProvider>));
  unmounts.push(() => act(async () => root.unmount()));
  return host;
};

afterEach(async () => {
  await Promise.all(unmounts.splice(0).map(unmount => unmount()));
  vault.session = { userId: 'u1', store };
  mail = null;
  transport.syncAccount.mockClear();
  vi.restoreAllMocks();
});

describe('MailProvider startup', () => {
  it('paints the cached list while the TLS stack is still loading', async () => {
    const inbox = createMailCache('u1', ADDRESS.address).folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 1, lastUid: 7, complete: true });
    await inbox.putSummaries([cachedSummary]);

    const host = await renderProvider(<Subjects />);

    await vi.waitFor(() => expect(host.textContent).toContain('Quarterly numbers'));
  });

  it('loads the TLS stack only after a frame has shown the cached list', async () => {
    const inbox = createMailCache('u1', ADDRESS.address).folder('inbox');
    await inbox.putSync({ name: 'INBOX', uidValidity: 1, lastUid: 7, complete: true });
    await inbox.putSummaries([cachedSummary]);
    // No frame is drawn until the test draws one.
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback =>
      frames.push(callback),
    );

    const host = await renderProvider(<Subjects />);
    await vi.waitFor(() => expect(host.textContent).toContain('Quarterly numbers'));
    // Ample for an import that did not wait for a frame to have loaded and run.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transport.syncAccount).not.toHaveBeenCalled();

    for (const frame of frames.splice(0)) frame(performance.now());
    await vi.waitFor(() => expect(transport.syncAccount).toHaveBeenCalledOnce());
  });

  it("a first sync that outlived its session leaves the next session's sync to be joined", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback =>
      frames.push(callback),
    );
    const root = createRoot(document.createElement('div'));
    const render = () =>
      act(async () =>
        root.render(
          <MailProvider>
            <Mail />
          </MailProvider>,
        ),
      );
    unmounts.push(() => act(async () => root.unmount()));
    await render();
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    // A lock and unlock while the first sync waits for its frame.
    vault.session = { userId: 'u3', store };
    await render();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    // The old session's sync resumes after its frame and finds itself stale.
    await act(async () => {
      frames[0]?.(performance.now());
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    // Joins the next session's sync, which still waits for its frame, rather than starting one.
    act(() => {
      void mail?.sync(ADDRESS.address);
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(transport.syncAccount).not.toHaveBeenCalled();
    await act(async () => frames[1]?.(performance.now()));
    await vi.waitFor(() => expect(transport.syncAccount).toHaveBeenCalledOnce());
  });

  it('syncs an address added after the address list was refused', async () => {
    vault.session = {
      userId: 'u2',
      store: {
        ...store,
        list: async () => {
          throw new Error('offline');
        },
      },
    };

    await renderProvider(<Mail />);
    await vi.waitFor(() => expect(mail?.recordsError).not.toBeNull());
    await act(async () => mail?.putAddress(ADDRESS));

    // The sync reached a live manager, which is opening the account's connection.
    await vi.waitFor(() =>
      expect(mail?.liveStates[ADDRESS.address]).toEqual({ status: 'connecting' }),
    );
  });
});
