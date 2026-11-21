// @vitest-environment jsdom

import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FromSwitch } from './FromSwitch';

const identity = {
  address: 'jason@fastmail.example',
  senderName: 'Jason Yu',
  imap: { host: 'imap.fastmail.example', port: 993, username: 'jason', password: 'pw' },
  smtp: { host: 'smtp.fastmail.example', port: 465, username: 'jason', password: 'pw' },
} as unknown as AddressRecord;

const other = {
  ...identity,
  address: 'jason@northlane.example',
  senderName: undefined,
  smtp: { host: 'smtp.northlane.example', port: 465, username: 'jason', password: 'pw' },
} as unknown as AddressRecord;

const mail = vi.hoisted(() => ({ identities: [] as unknown[] }));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const host = document.createElement('div');
const root = createRoot(host);

beforeEach(() => {
  mail.identities = [identity];
  document.body.append(host);
});

afterEach(async () => {
  host.remove();
  await act(async () => root.render(null));
});

const trigger = () => {
  const button = host.querySelector('button');
  if (button === null) throw new Error('no From trigger');
  return button;
};

describe('the From line', () => {
  it('names the host that sends and leaves the port to Settings', async () => {
    await act(async () => root.render(<FromSwitch value={identity.address} onChange={() => {}} />));
    expect(host.textContent).toContain('Jason Yu · via smtp.fastmail.example');
    expect(host.textContent).not.toContain(':465');
  });

  it('marks the chosen address with the signal edge', async () => {
    await act(async () => root.render(<FromSwitch value={identity.address} onChange={() => {}} />));
    expect(host.textContent).toContain(identity.address);
    expect(host.querySelector('.bg-signal')).not.toBeNull();
  });

  it('asks for an address, with no signal edge, when none is chosen — even with only one to choose', async () => {
    await act(async () => root.render(<FromSwitch value="" onChange={() => {}} />));
    expect(host.textContent).toContain('Choose an address');
    expect(host.textContent).not.toContain(identity.address);
    expect(host.querySelector('.bg-signal')).toBeNull();
  });

  it('is named by its label and the value it shows, not by a label that hides the value', async () => {
    const accessibleName = () =>
      (trigger().getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map(id => document.getElementById(id)?.textContent)
        .join(' ');

    await act(async () => root.render(<FromSwitch value="" onChange={() => {}} />));
    expect(trigger().getAttribute('role')).toBe('combobox');
    expect(trigger().hasAttribute('aria-label')).toBe(false);
    expect(accessibleName()).toBe('From Choose an address');

    await act(async () => root.render(<FromSwitch value={identity.address} onChange={() => {}} />));
    expect(accessibleName()).toMatch(
      /^From jason@fastmail\.example.*via smtp\.fastmail\.example$/u,
    );
  });

  it('treats a value that is not one of your addresses as unchosen', async () => {
    mail.identities = [identity, other];
    await act(async () => root.render(<FromSwitch value="gone@x.example" onChange={() => {}} />));
    expect(host.textContent).toContain('Choose an address');
  });

  it('hands the trigger to the ref it is given', async () => {
    const triggerRef = createRef<HTMLButtonElement>();
    await act(async () =>
      root.render(<FromSwitch value="" onChange={() => {}} triggerRef={triggerRef} />),
    );
    expect(triggerRef.current).toBe(trigger());
  });

  it('says there is no address to send from when you have none', async () => {
    mail.identities = [];
    await act(async () => root.render(<FromSwitch value="" onChange={() => {}} />));
    expect(host.textContent).toContain('No address to send from');
    expect(trigger().disabled).toBe(true);
  });

  it('chooses an address from the unchosen state', async () => {
    mail.identities = [identity, other];
    const onChange = vi.fn();
    await act(async () => root.render(<FromSwitch value="" onChange={onChange} />));
    await act(async () => trigger().click());
    const option = [...document.querySelectorAll('[role="option"]')].find(candidate =>
      candidate.textContent?.includes(other.address),
    );
    if (!(option instanceof HTMLElement)) throw new Error('the list has no northlane option');
    await act(async () => option.click());
    expect(onChange).toHaveBeenCalledWith(other.address);
  });
});
