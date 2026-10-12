// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressRail } from './AddressRail';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ mailbox: 'unified' as string | undefined }));
const mail = vi.hoisted(() => ({
  accounts: [{ address: 'me@example.com' }],
  threads: [],
  sync: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    onClick,
    'aria-current': ariaCurrent,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-current'?: 'page';
  }) => (
    <a href="https://yozz.test" onClick={onClick} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
  useParams: () => ({ mailbox: route.mailbox }),
  useLocation: () => false,
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
const show = () => act(async () => root.render(<AddressRail />));
const click = (name: string) => {
  const row = [...host.querySelectorAll('a')].find(link => link.textContent?.startsWith(name));
  if (row === undefined) throw new Error(`No ${name} row`);
  return act(async () => row.click());
};

afterEach(async () => {
  await act(async () => root.render(null));
  mail.sync.mockClear();
});

describe('AddressRail', () => {
  it('syncs every address when the open Inbox is clicked again', async () => {
    route.mailbox = 'unified';
    await show();
    await click('Inbox');
    expect(mail.sync).toHaveBeenCalledWith(undefined);
  });

  it('syncs one address when its open row is clicked again', async () => {
    route.mailbox = 'me@example.com';
    await show();
    await click('me@example.com');
    expect(mail.sync).toHaveBeenCalledWith('me@example.com');
  });

  it('only opens a mailbox that is not the open one', async () => {
    route.mailbox = 'unified';
    await show();
    await click('me@example.com');
    expect(mail.sync).not.toHaveBeenCalled();
  });
});
