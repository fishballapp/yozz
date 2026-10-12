// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = { address: 'me@example.com', imap: { host: 'imap.example.com' } };
const mail = vi.hoisted(() => ({
  accounts: [] as unknown[],
  isDemo: false,
  syncStates: {} as Record<string, unknown>,
  mailError: null as string | null,
  sentCopyError: null as string | null,
  sync: vi.fn(),
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const host = document.createElement('div');
const root = createRoot(host);
const show = () => act(async () => root.render(<StatusBar title="Inbox" />));
const notice = () => host.querySelector('footer > p:nth-of-type(2)');

afterEach(async () => {
  await act(async () => root.render(null));
  Object.assign(mail, { accounts: [ACCOUNT], syncStates: {}, mailError: null });
  mail.sync.mockClear();
});

describe('StatusBar', () => {
  it('says nothing at its right end while all is well', async () => {
    mail.accounts = [ACCOUNT];
    mail.syncStates = { [ACCOUNT.address]: { status: 'synced', at: 1000 } };
    await show();
    expect(notice()).toBeNull();
  });

  it('names a failed sync and retries that address', async () => {
    mail.accounts = [ACCOUNT];
    mail.syncStates = {
      [ACCOUNT.address]: { status: 'failed', failure: { kind: 'stalled' }, at: 1000 },
    };
    await show();
    expect(notice()?.textContent).toBe('imap.example.com has not answered for a minute·Retry');

    await act(async () => host.querySelector('button')?.click());
    expect(mail.sync).toHaveBeenCalledWith(ACCOUNT.address);
  });

  it('says what a move refused', async () => {
    mail.accounts = [ACCOUNT];
    mail.mailError = 'thread not moved · imap.example.com: Archive is read-only';
    await show();
    expect(notice()?.textContent).toBe('thread not moved · imap.example.com: Archive is read-only');
    expect(host.querySelector('button')).toBeNull();
  });
});
