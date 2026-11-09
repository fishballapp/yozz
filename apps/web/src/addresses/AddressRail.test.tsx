// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressRail } from './AddressRail';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const route = vi.hoisted(() => ({ view: 'unified' as string | undefined }));
const mail = vi.hoisted(() => ({
  mailboxes: [{ address: 'me@example.com' }],
  threads: [],
  sync: vi.fn(),
  junkFolders: {} as Record<string, boolean>,
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
  useSearch: () => ({}),
  useParams: () => ({ view: route.view }),
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
  mail.junkFolders = {};
});

describe('AddressRail', () => {
  it('syncs every address when the open Inbox is clicked again', async () => {
    route.view = 'unified';
    await show();
    await click('Inbox');
    expect(mail.sync).toHaveBeenCalledWith(undefined);
  });

  it('syncs one address when its open row is clicked again', async () => {
    route.view = 'me@example.com';
    await show();
    await click('me@example.com');
    expect(mail.sync).toHaveBeenCalledWith('me@example.com');
  });

  it('only opens a view that is not the open one', async () => {
    route.view = 'unified';
    await show();
    await click('me@example.com');
    expect(mail.sync).not.toHaveBeenCalled();
  });

  it('shows Junk only once a server has listed one, since YOZZ never creates it', async () => {
    route.view = 'unified';
    const labels = () => [...host.querySelectorAll('a')].map(link => link.textContent);
    await show();
    expect(labels()).not.toContain('Junk');
    mail.junkFolders = { 'me@example.com': true };
    await show();
    expect(labels()).toContain('Junk');
  });
});
