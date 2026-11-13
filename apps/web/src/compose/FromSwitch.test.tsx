// @vitest-environment jsdom

import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FromSwitch } from './FromSwitch';

const identity = {
  address: 'jason@fastmail.example',
  senderName: 'Jason Yu',
  imap: { host: 'imap.fastmail.example', port: 993, username: 'jason', password: 'pw' },
  smtp: { host: 'smtp.fastmail.example', port: 465, username: 'jason', password: 'pw' },
} as unknown as AddressRecord;

vi.mock('../store/MailProvider', () => ({ useMail: () => ({ identities: [identity] }) }));

const host = document.createElement('div');
const root = createRoot(host);

afterEach(async () => {
  await act(async () => root.render(null));
});

describe('the From line', () => {
  it('names the host that sends and leaves the port to Settings', async () => {
    await act(async () => root.render(<FromSwitch value={identity.address} onChange={() => {}} />));
    expect(host.textContent).toContain('Jason Yu · via smtp.fastmail.example');
    expect(host.textContent).not.toContain(':465');
  });
});
