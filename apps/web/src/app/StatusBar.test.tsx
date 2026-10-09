// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';

vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    accounts: [{ address: 'me@example.com' }],
    identities: [{ address: 'me@example.com' }],
    isDemo: false,
    syncStates: { 'me@example.com': { status: 'synced', at: 1000 } },
    liveStates: {},
    mailError: 'thread not moved · imap.example.com: Archive is read-only',
    sentCopyError: null,
    sync: vi.fn(),
  }),
}));

describe('StatusBar', () => {
  it('says what failed and why, in place of the synced time', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(<StatusBar title="Inbox" />));

    const status = host.querySelector('button');
    expect(status?.textContent).toBe('thread not moved · imap.example.com: Archive is read-only');
    expect(status?.title).toBe('thread not moved · imap.example.com: Archive is read-only');
    await act(async () => root.unmount());
  });
});
