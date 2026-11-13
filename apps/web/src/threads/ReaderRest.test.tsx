// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderRest } from './ReaderRest';

const mail = vi.hoisted(() => ({ mailboxes: [] as { address: string }[] }));

vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));
vi.mock('./use-listing', () => ({ useListing: () => undefined }));

const host = document.createElement('div');
const root = createRoot(host);

afterEach(async () => {
  await act(async () => root.render(null));
});

describe('the reader with nothing open', () => {
  it('says there is no address and offers nothing: the list beside it holds the one button', async () => {
    await act(async () => root.render(<ReaderRest />));
    expect(host.textContent).toBe('No address connected yet.');
    expect(host.querySelector('a, button')).toBeNull();
  });

  it('says only how the list stands once there is an address', async () => {
    mail.mailboxes = [{ address: 'me@x.test' }];
    await act(async () => root.render(<ReaderRest />));
    expect(host.textContent).toBe('Nothing selected');
    mail.mailboxes = [];
  });
});
