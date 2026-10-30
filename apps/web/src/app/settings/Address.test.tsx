// @vitest-environment jsdom

import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Address } from './Address';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SEND_ONLY: AddressRecord = {
  address: 'alice@example.com',
  senderName: 'Alice',
  smtp: { host: 'smtp.example.com', port: 465, username: 'alice', password: 'pw' },
};
const INBOUND: AddressRecord = {
  ...SEND_ONLY,
  imap: { host: 'imap.example.com', port: 993, username: 'alice', password: 'pw' },
};

/**
 * The store's addresses, re-rendering the page when they change, as `useMail` would, and a session a
 * test can end, as a lock or a sign-in would.
 */
const mocks = vi.hoisted(() => ({
  generation: 0,
  address: 'alice@example.com',
  identities: [] as readonly AddressRecord[],
  listeners: new Set<() => void>(),
  removeAddress: vi.fn<(address: string) => Promise<void>>(),
  replaceAddress: vi.fn<(record: AddressRecord) => Promise<void>>(),
  setSenderName: vi.fn<(address: string, senderName: string) => Promise<void>>(),
  navigate: vi.fn(async (_options: unknown) => {}),
  testImap: vi.fn<(imap: unknown) => Promise<Result<void, MailConnectionFailure>>>(),
  testSmtp: vi.fn<(smtp: unknown) => Promise<Result<void, MailConnectionFailure>>>(),
}));

const setIdentities = (identities: readonly AddressRecord[]) => {
  mocks.identities = identities;
  for (const listener of mocks.listeners) listener();
};

vi.mock('../../store/MailProvider', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useMail: () => ({
      identities: useSyncExternalStore(
        listener => {
          mocks.listeners.add(listener);
          return () => mocks.listeners.delete(listener);
        },
        () => mocks.identities,
      ),
      isDemo: false,
      removeAddress: mocks.removeAddress,
      replaceAddress: mocks.replaceAddress,
      setSenderName: mocks.setSenderName,
      watchSession: () => {
        const taken = mocks.generation;
        return () => mocks.generation === taken;
      },
    }),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ address: mocks.address }),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('../../relay/probe', () => ({ testImap: mocks.testImap, testSmtp: mocks.testSmtp }));

const OK = { ok: true, value: undefined } as const;
const REFUSED = (error: MailConnectionFailure) => ({ ok: false, error }) as const;

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Address />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

const button = (label: string) => {
  const found = [...document.body.querySelectorAll('button')].findLast(
    candidate => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
};

const section = (label: string) => {
  const found = [...document.body.querySelectorAll('section')].find(
    candidate => candidate.querySelector('h3')?.textContent === label,
  );
  if (found === undefined) throw new Error(`no "${label}" section`);
  return found;
};

const field = (id: string) => {
  const found = document.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`no #${id} field`);
  return found;
};

const typeInto = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const displayName = () => {
  const found = document.querySelector<HTMLInputElement>(
    'input[aria-labelledby="address-display-name"]',
  );
  if (found === null) throw new Error('no display name field');
  return found;
};

const submit = async (form: Element | null) => {
  await act(async () =>
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
};

const confirmRemoval = async () => {
  await act(async () => button('Remove address').click());
  await act(async () => button('Remove address').click());
};

beforeEach(() => {
  mocks.address = SEND_ONLY.address;
  mocks.testImap.mockResolvedValue(OK);
  mocks.testSmtp.mockResolvedValue(OK);
  mocks.replaceAddress.mockResolvedValue();
  mocks.setSenderName.mockResolvedValue();
  setIdentities([SEND_ONLY]);
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.clearAllMocks();
});

describe('Address header', () => {
  it('says what the address does', async () => {
    const send = await mount();
    expect(send.querySelector('header p')?.textContent).toBe('Sends only');
    expect(send.querySelector('header')?.textContent).toContain('send-only');

    await act(async () => setIdentities([INBOUND]));
    expect(send.querySelector('header p')?.textContent).toBe('Reads and sends');
  });
});

describe('Display name', () => {
  it('saves on blur and says Saved beside the field, which fades', async () => {
    vi.useFakeTimers();
    try {
      const page = await mount();
      await act(async () => {
        displayName().focus();
      });
      await typeInto(displayName(), 'Al');
      await act(async () => displayName().blur());

      expect(mocks.setSenderName).toHaveBeenCalledWith(SEND_ONLY.address, 'Al');
      const saved = page.querySelector('[aria-live="polite"]');
      expect(saved?.textContent).toBe('Saved');
      expect(saved?.className).toContain('opacity-100');

      await act(async () => vi.advanceTimersByTime(2000));
      expect(saved?.className).toContain('opacity-0');
      await act(async () => vi.advanceTimersByTime(300));
      expect(saved?.textContent).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves on Enter', async () => {
    const page = await mount();
    await typeInto(displayName(), 'Ally');
    await submit(page.querySelector('form'));
    expect(mocks.setSenderName).toHaveBeenCalledWith(SEND_ONLY.address, 'Ally');
  });

  it('saves nothing when nothing changed', async () => {
    await mount();
    await act(async () => displayName().focus());
    await act(async () => displayName().blur());
    expect(mocks.setSenderName).not.toHaveBeenCalled();
  });

  it('previews the From line under the field', async () => {
    const page = await mount();
    expect(page.textContent).toContain('Recipients see Alice <alice@example.com>.');
    await typeInto(displayName(), '');
    expect(page.textContent).toContain('Recipients see alice@example.com.');
  });

  it('shows a refusal under the field, in its own section, and no Saved', async () => {
    mocks.setSenderName.mockRejectedValue(new Error('The vault refused'));
    const page = await mount();
    await act(async () => displayName().focus());
    await typeInto(displayName(), 'Al');
    await act(async () => displayName().blur());

    expect(section('Display name').querySelector('[role="alert"]')?.textContent).toBe(
      'The vault refused',
    );
    expect(page.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });
});

describe('Servers', () => {
  beforeEach(() => {
    setIdentities([INBOUND]);
    mocks.address = INBOUND.address;
  });

  it('lists the servers and the one login as facts', async () => {
    await mount();
    const text = section('Servers').textContent;
    expect(text).toContain('imap.example.com:993');
    expect(text).toContain('smtp.example.com:465');
    expect(text).toContain('Username');
    expect(section('Servers').querySelector('form')).toBeNull();
  });

  it('Edit turns the section into a form, and Cancel restores the facts untouched', async () => {
    await mount();
    await act(async () => button('Edit').click());
    expect(field('address-imap-host').value).toBe('imap.example.com');
    expect(field('address-smtp-port').value).toBe('465');
    expect(field('address-password').value).toBe('');

    await typeInto(field('address-imap-host'), 'imap.other.example');
    await act(async () => button('Cancel').click());
    expect(section('Servers').querySelector('form')).toBeNull();
    expect(section('Servers').textContent).toContain('imap.example.com:993');

    await act(async () => button('Edit').click());
    expect(field('address-imap-host').value).toBe('imap.example.com');
  });

  it('returns the keyboard to Edit once the facts are back', async () => {
    await mount();
    await act(async () => button('Edit').click());
    await act(async () => button('Cancel').click());
    expect(document.activeElement).toBe(button('Edit'));
  });

  it('tests both servers, naming each, then stores the record, keeping a blank password', async () => {
    const imap = Promise.withResolvers<Result<void, MailConnectionFailure>>();
    mocks.testImap.mockReturnValue(imap.promise);
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-imap-host'), 'imap.other.example');
    await typeInto(field('address-username'), 'alice2');
    await submit(section('Servers').querySelector('form'));

    expect(button('Testing imap.other.example…').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    expect(mocks.replaceAddress).not.toHaveBeenCalled();

    await act(async () => imap.resolve(OK));
    expect(mocks.testSmtp).toHaveBeenCalled();
    expect(mocks.replaceAddress).toHaveBeenCalledWith({
      ...INBOUND,
      imap: { host: 'imap.other.example', port: 993, username: 'alice2', password: 'pw' },
      smtp: { ...INBOUND.smtp, username: 'alice2' },
    });
    expect(section('Servers').querySelector('form')).toBeNull();
  });

  it('a new password goes to both servers', async () => {
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-password'), 'fresh');
    await submit(section('Servers').querySelector('form'));

    expect(mocks.testImap).toHaveBeenCalledWith(expect.objectContaining({ password: 'fresh' }));
    expect(mocks.testSmtp).toHaveBeenCalledWith(expect.objectContaining({ password: 'fresh' }));
  });

  it('locks every field while the tests run, so nothing typed meanwhile is dropped', async () => {
    const imap = Promise.withResolvers<Result<void, MailConnectionFailure>>();
    mocks.testImap.mockReturnValue(imap.promise);
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-password'), 'fresh');
    await submit(section('Servers').querySelector('form'));

    for (const id of [
      'address-imap-host',
      'address-smtp-port',
      'address-username',
      'address-password',
    ]) {
      expect(field(id).matches(':disabled')).toBe(true);
    }
    await act(async () => imap.resolve(OK));
    expect(section('Servers').querySelector('form')).toBeNull();
  });

  it('stores nothing and tests nothing when nothing was edited', async () => {
    await mount();
    await act(async () => button('Edit').click());
    await submit(section('Servers').querySelector('form'));

    expect(mocks.testImap).not.toHaveBeenCalled();
    expect(mocks.replaceAddress).not.toHaveBeenCalled();
    expect(section('Servers').querySelector('form')).toBeNull();
  });

  it('keeps a failed IMAP test in the form, under the IMAP server, and stores nothing', async () => {
    mocks.testImap.mockResolvedValue(REFUSED({ kind: 'auth', text: 'AUTHENTICATIONFAILED' }));
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-password'), 'wrong');
    await submit(section('Servers').querySelector('form'));

    const alert = section('Servers').querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('imap.example.com rejected the username or password');
    expect(alert?.previousElementSibling?.contains(field('address-imap-host'))).toBe(true);
    expect(mocks.testSmtp).not.toHaveBeenCalled();
    expect(mocks.replaceAddress).not.toHaveBeenCalled();
    expect(button('Save').disabled).toBe(false);
    expect(field('address-password').value).toBe('wrong');
  });

  it('keeps a failed SMTP test under the SMTP server', async () => {
    mocks.testSmtp.mockResolvedValue(REFUSED({ kind: 'auth', text: 'AUTHENTICATIONFAILED' }));
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-smtp-host'), 'smtp.other.example');
    await submit(section('Servers').querySelector('form'));

    expect(section('Servers').querySelector('[role="alert"]')?.textContent).toBe(
      'smtp.other.example rejected the username or password',
    );
    expect(mocks.replaceAddress).not.toHaveBeenCalled();
  });

  it('refuses a port that is not a port before testing anything', async () => {
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-smtp-port'), '99999');
    await submit(section('Servers').querySelector('form'));

    expect(section('Servers').querySelector('[role="alert"]')?.textContent).toContain('SMTP host');
    expect(mocks.testImap).not.toHaveBeenCalled();
  });

  it("shows the vault's refusal in the Servers section and stays in the form", async () => {
    mocks.replaceAddress.mockRejectedValue(new Error('The vault refused'));
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-password'), 'fresh');
    await submit(section('Servers').querySelector('form'));

    expect(section('Servers').querySelector('[role="alert"]')?.textContent).toBe(
      'The vault refused',
    );
    expect(section('Servers').querySelector('form')).not.toBeNull();
  });

  it('stores nothing and shows nothing once the session ended under the tests', async () => {
    const imap = Promise.withResolvers<Result<void, MailConnectionFailure>>();
    mocks.testImap.mockReturnValue(imap.promise);
    await mount();
    await act(async () => button('Edit').click());
    await typeInto(field('address-password'), 'fresh');
    await submit(section('Servers').querySelector('form'));

    mocks.generation += 1;
    await act(async () => imap.resolve(OK));
    expect(mocks.testSmtp).not.toHaveBeenCalled();
    expect(mocks.replaceAddress).not.toHaveBeenCalled();
  });

  it('asks for the two usernames when the address has two', async () => {
    setIdentities([{ ...INBOUND, smtp: { ...INBOUND.smtp, username: 'alice-out' } }]);
    await mount();
    expect(section('Servers').textContent).toContain('IMAP user');
    await act(async () => button('Edit').click());
    expect(field('address-imap-username').value).toBe('alice');
    expect(field('address-smtp-username').value).toBe('alice-out');
  });

  it('edits a send-only address without an IMAP server', async () => {
    mocks.address = SEND_ONLY.address;
    setIdentities([SEND_ONLY]);
    await mount();
    expect(section('Servers').textContent).not.toContain('IMAP');
    await act(async () => button('Edit').click());
    expect(document.getElementById('address-imap-host')).toBeNull();
    await typeInto(field('address-smtp-host'), 'smtp.other.example');
    await submit(section('Servers').querySelector('form'));

    expect(mocks.testImap).not.toHaveBeenCalled();
    expect(mocks.replaceAddress).toHaveBeenCalledWith({
      ...SEND_ONLY,
      smtp: { ...SEND_ONLY.smtp, host: 'smtp.other.example' },
    });
  });
});

describe('Remove', () => {
  it('keeps the page while the vault deletes the address, then leaves for the list', async () => {
    const vaultDelete = Promise.withResolvers<void>();
    mocks.removeAddress.mockImplementation(async () => {
      await vaultDelete.promise;
      setIdentities([]);
    });
    const page = await mount();

    await confirmRemoval();
    expect(button('Removing…').disabled).toBe(true);
    expect(mocks.navigate).not.toHaveBeenCalled();

    await act(async () => vaultDelete.resolve());
    // The store has dropped the address; the page still shows it as it leaves.
    expect(page.textContent).toContain(SEND_ONLY.address);
    expect(page.textContent).not.toContain('Not one of your addresses');
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/settings' }));
  });

  it('goes nowhere once the session ended under the vault delete', async () => {
    const vaultDelete = Promise.withResolvers<void>();
    mocks.removeAddress.mockImplementation(() => vaultDelete.promise);
    await mount();
    await confirmRemoval();

    mocks.generation += 1;
    await act(async () => vaultDelete.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('says nothing once the session ended under a refused vault delete', async () => {
    const vaultDelete = Promise.withResolvers<void>();
    mocks.removeAddress.mockImplementation(() => vaultDelete.promise);
    const page = await mount();
    await confirmRemoval();

    mocks.generation += 1;
    await act(async () => vaultDelete.reject(new Error('The vault refused')));
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it('stays on the page with the refusal inside the Remove section when the vault keeps the address', async () => {
    mocks.removeAddress.mockRejectedValue(new Error('The vault refused'));
    const page = await mount();

    await confirmRemoval();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(section('Remove').querySelector('[role="alert"]')?.textContent).toBe(
      'The vault refused',
    );
    expect(page.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(button('Remove address').disabled).toBe(false);
  });
});
