// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressRecord } from '../../addresses/record';
import type { MailConnectionFailure } from '../../relay/connection';
import { AddAddress } from './AddAddress';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const FOUND = {
  status: 'found',
  config: {
    imap: { host: 'imap.example.com', port: 993 },
    smtp: { host: 'smtp.example.com', port: 465 },
    username: 'address',
    source: 'provider',
    sourceDomain: 'example.com',
  },
} as const;

/** The store as the form sees it, with a session a test can end, as a lock or a sign-in would. */
const mocks = vi.hoisted(() => ({
  generation: 0,
  identities: [] as AddressRecord[],
  putAddress: vi.fn<(record: AddressRecord) => Promise<void>>(async () => {}),
  navigate: vi.fn(async (_options: unknown) => {}),
  lookupResult: null as unknown,
  /** The IMAP credential test waits here. */
  imapTest: null as PromiseWithResolvers<void> | null,
  /** A failure for the IMAP test to report, when set. */
  imapFailure: null as MailConnectionFailure | null,
  /** The address lookup waits here, when set. */
  lookupGate: null as PromiseWithResolvers<void> | null,
}));

vi.mock('../../store/MailProvider', () => ({
  useMail: () => ({
    identities: mocks.identities,
    putAddress: mocks.putAddress,
    isDemo: false,
    watchSession: () => {
      const taken = mocks.generation;
      return () => mocks.generation === taken;
    },
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  Link: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <a href="/" onClick={onClick}>
      {children}
    </a>
  ),
}));

vi.mock('../../addresses/autoconfig', async importOriginal => ({
  ...(await importOriginal<typeof import('../../addresses/autoconfig')>()),
  lookupMailServers: async () => {
    await mocks.lookupGate?.promise;
    return mocks.lookupResult;
  },
}));
vi.mock('../../threads/sync', () => ({
  testImap: async () => {
    await mocks.imapTest?.promise;
    if (mocks.imapFailure !== null) return { ok: false, error: mocks.imapFailure };
    return { ok: true, value: undefined };
  },
}));
vi.mock('../../compose/send', () => ({ testSmtp: async () => ({ ok: true, value: undefined }) }));

const endSession = () => {
  mocks.generation += 1;
};

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AddAddress />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

const type = (page: HTMLElement, id: string, value: string) => {
  const input = page.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) throw new Error(`no #${id}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const buttonNamed = (page: HTMLElement, label: string) => {
  const button = [...page.querySelectorAll('button')].find(
    candidate => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`no button "${label}"`);
  return button;
};

/** Only the open step renders a form, so the page's one form is the step to submit. */
const submitStep = async (page: HTMLElement) => {
  const form = page.querySelector('form');
  if (form === null) throw new Error('no open step');
  await act(async () => form.requestSubmit());
};

/** The address (with no name) through its lookup, to the servers step. */
const toServers = async (page: HTMLElement, addressValue = 'alice@example.com') => {
  await act(async () => type(page, 'connect-address', addressValue));
  await submitStep(page);
  await vi.waitFor(() => expect(page.textContent).toContain('Step 2 of 3'));
};

/** The whole flow to the password step, with the password typed. */
const toPassword = async (page: HTMLElement) => {
  await toServers(page);
  await submitStep(page);
  await vi.waitFor(() => expect(page.textContent).toContain('Step 3 of 3'));
  await act(async () => type(page, 'connect-password', 'pw'));
};

const submitAll = async (page: HTMLElement) => {
  await toPassword(page);
  await submitStep(page);
};

beforeEach(() => {
  mocks.lookupResult = FOUND;
  mocks.imapTest = null;
  mocks.imapFailure = null;
  mocks.lookupGate = null;
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  mocks.identities = [];
  vi.clearAllMocks();
});

describe('AddAddress', () => {
  it('walks the three steps and stores a tested address under its name', async () => {
    const page = await mount();
    await act(async () => type(page, 'connect-name', 'Jason Yu'));
    await submitAll(page);
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: { mailbox: 'alice@example.com' } }),
      ),
    );
    expect(mocks.putAddress).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'alice@example.com', senderName: 'Jason Yu' }),
    );
  });

  it('says what was found, shows it read-only, and keeps one Edit for the step', async () => {
    const page = await mount();
    await toServers(page);
    expect(page.textContent).toContain("Found example.com's settings.");
    expect(page.querySelector('#connect-imap-host')).toBeNull();
    expect(page.textContent).toContain('imap.example.com:993');
    expect(page.textContent).toContain('alice@example.com');
    const edits = [...page.querySelectorAll('button')].filter(
      candidate => candidate.textContent === 'Edit',
    );
    expect(edits).toHaveLength(1);
  });

  it('turns every found value into a field at once, and Continue uses what is in them', async () => {
    const page = await mount();
    await toServers(page);
    await act(async () => buttonNamed(page, 'Edit').click());
    expect(page.querySelector('#connect-imap-host')).not.toBeNull();
    expect(page.querySelector('#connect-username')).toBeNull();
    await act(async () => type(page, 'connect-imap-host', 'imap.elsewhere.test'));
    await submitStep(page);
    await vi.waitFor(() => expect(page.textContent).toContain('Step 3 of 3'));
    await act(async () => type(page, 'connect-password', 'pw'));
    await submitStep(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());
    expect(mocks.putAddress.mock.calls[0]?.[0].imap?.host).toBe('imap.elsewhere.test');
  });

  it('keeps the username off the servers step and prefills it on Sign-in', async () => {
    const page = await mount();
    await toServers(page);
    expect(page.querySelector('#connect-username')).toBeNull();
    expect(page.textContent).not.toContain('Username');
    await submitStep(page);
    await vi.waitFor(() => expect(page.textContent).toContain('Step 3 of 3'));
    expect(page.querySelector<HTMLInputElement>('#connect-username')?.value).toBe(
      'alice@example.com',
    );
  });

  it('stores the username typed on Sign-in, not the address', async () => {
    const page = await mount();
    await toPassword(page);
    await act(async () => type(page, 'connect-username', 'alice-login'));
    await submitStep(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());
    expect(mocks.putAddress.mock.calls[0]?.[0].smtp.username).toBe('alice-login');
  });

  it('resets the prefilled username when the address changes', async () => {
    const page = await mount();
    await toPassword(page);
    await act(async () => type(page, 'connect-username', 'typed-login'));
    const addressRow = [...page.querySelectorAll('span.label-rule')]
      .find(candidate => candidate.textContent === 'Address')
      ?.closest('div.flex');
    await act(async () =>
      [...(addressRow?.querySelectorAll('button') ?? [])]
        .find(b => b.textContent === 'Change')
        ?.click(),
    );
    await act(async () => type(page, 'connect-address', 'bob@example.com'));
    await submitStep(page);
    await vi.waitFor(() => expect(page.textContent).toContain('Step 2 of 3'));
    await submitStep(page);
    await vi.waitFor(() => expect(page.textContent).toContain('Step 3 of 3'));
    expect(page.querySelector<HTMLInputElement>('#connect-username')?.value).toBe(
      'bob@example.com',
    );
  });

  it('shows empty server fields straight away when nothing was found', async () => {
    mocks.lookupResult = { status: 'none' };
    const page = await mount();
    await toServers(page);
    expect(page.textContent).toContain('Nothing was found for example.com.');
    expect(page.querySelector<HTMLInputElement>('#connect-imap-port')?.value).toBe('993');
    expect(page.querySelector<HTMLInputElement>('#connect-smtp-port')?.value).toBe('465');
    expect(page.querySelector<HTMLInputElement>('#connect-smtp-host')?.value).toBe('');
  });

  it('hides IMAP when send-only is chosen, and stores no IMAP record', async () => {
    const page = await mount();
    await toServers(page);
    await act(async () => {
      page.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    });
    expect(page.textContent).not.toContain('imap.example.com');
    await submitStep(page);
    await act(async () => type(page, 'connect-password', 'pw'));
    await submitStep(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());
    expect(mocks.putAddress.mock.calls[0]?.[0].imap).toBeUndefined();
  });

  it('says a duplicate under the address on step 1', async () => {
    mocks.identities = [
      {
        address: 'alice@example.com',
        smtp: { host: 'smtp.example.com', port: 465, username: 'alice', password: 'pw' },
      },
    ];
    const page = await mount();
    await act(async () => type(page, 'connect-address', 'alice@example.com'));
    await submitStep(page);
    expect(page.querySelector('[role="alert"]')?.textContent).toBe(
      'That address is already stored. Open it from Settings.',
    );
    expect(page.textContent).toContain('Step 1 of 3');
  });

  it('reopens an earlier step from Change and keeps the answers after it', async () => {
    const page = await mount();
    await act(async () => type(page, 'connect-name', 'Jason Yu'));
    await toPassword(page);
    expect(page.textContent).toContain('Jason Yu');
    expect(page.textContent).toContain('imap.example.com:993');
    await act(async () => buttonNamed(page, 'Change').click());
    expect(page.textContent).toContain('Step 1 of 3');
    expect(page.querySelector<HTMLInputElement>('#connect-name')?.value).toBe('Jason Yu');
    expect(page.textContent).toContain('imap.example.com:993');
  });

  it('keeps a refused login under the password, on step 3', async () => {
    mocks.imapFailure = { kind: 'auth', text: 'Invalid credentials' };
    const page = await mount();
    await submitAll(page);
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toBe(
        'imap.example.com rejected the username or password',
      ),
    );
    expect(page.textContent).toContain('Step 3 of 3');
    expect(mocks.putAddress).not.toHaveBeenCalled();
  });

  it('puts a server failure under the servers answer, with Change to reach them', async () => {
    mocks.imapFailure = { kind: 'relay', detail: 'connection refused' };
    const page = await mount();
    await submitAll(page);
    await vi.waitFor(() =>
      expect(page.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not reach the relay: connection refused',
      ),
    );
    expect(page.textContent).toContain('Step 3 of 3');
    expect(page.textContent).toContain('imap.example.com:993');
  });

  it('makes the address read-only while its lookup runs', async () => {
    mocks.lookupGate = Promise.withResolvers();
    const page = await mount();
    await act(async () => type(page, 'connect-address', 'alice@example.com'));
    await submitStep(page);
    expect(page.querySelector<HTMLInputElement>('#connect-address')?.readOnly).toBe(true);
    await act(async () => mocks.lookupGate?.resolve());
    await vi.waitFor(() => expect(page.textContent).toContain('Step 2 of 3'));
  });

  it('stores the address that was looked up, not one typed while the lookup waited', async () => {
    mocks.lookupGate = Promise.withResolvers();
    const page = await mount();
    await act(async () => type(page, 'connect-address', 'alice@example.com'));
    await submitStep(page);
    await act(async () => type(page, 'connect-address', 'bob@example.com'));
    await act(async () => mocks.lookupGate?.resolve());
    await vi.waitFor(() => expect(page.textContent).toContain('Step 2 of 3'));
    await submitStep(page);
    await act(async () => type(page, 'connect-password', 'pw'));
    await submitStep(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());
    expect(mocks.putAddress.mock.calls[0]?.[0].address).toBe('alice@example.com');
  });

  it('disables every Change and field while the test runs', async () => {
    mocks.imapTest = Promise.withResolvers();
    const page = await mount();
    await toPassword(page);
    await submitStep(page);
    const changes = [...page.querySelectorAll('button')].filter(b => b.textContent === 'Change');
    expect(changes).toHaveLength(2);
    for (const change of changes) expect(change.matches(':disabled')).toBe(true);
    expect(page.querySelector<HTMLInputElement>('#connect-username')?.matches(':disabled')).toBe(
      true,
    );
    expect(page.querySelector<HTMLInputElement>('#connect-password')?.matches(':disabled')).toBe(
      true,
    );
    await act(async () => mocks.imapTest?.resolve());
  });

  it('ends an add whose page is left during its test, before it stores anything', async () => {
    mocks.imapTest = Promise.withResolvers();
    const page = await mount();
    await toPassword(page);
    await submitStep(page);
    await act(async () => unmounts.pop()?.());
    await act(async () => mocks.imapTest?.resolve());
    await act(async () => {});
    expect(mocks.putAddress).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('ends an add when Cancel is pressed during its test, before it stores anything', async () => {
    mocks.imapTest = Promise.withResolvers();
    const page = await mount();
    await toPassword(page);
    await submitStep(page);
    const cancel = [...page.querySelectorAll('a')].find(a => a.textContent === 'Cancel');
    // A user's click. jsdom's click() skips an element inside a disabled fieldset; a browser does not.
    expect(cancel).toBeDefined();
    await act(async () => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => mocks.imapTest?.resolve());
    await act(async () => {});
    expect(mocks.putAddress).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('puts focus on the address when the page opens', async () => {
    await mount();
    expect(document.activeElement?.id).toBe('connect-address');
  });

  it('moves focus to the username when Sign-in opens', async () => {
    const page = await mount();
    await toServers(page);
    await submitStep(page);
    expect(document.activeElement?.id).toBe('connect-username');
  });

  it('moves focus to the first server field when nothing was found', async () => {
    mocks.lookupResult = { status: 'none' };
    const page = await mount();
    await toServers(page);
    expect(document.activeElement?.id).toBe('connect-imap-host');
  });

  it('moves focus to Edit when a found servers step is reopened', async () => {
    const page = await mount();
    await toPassword(page);
    const servers = [...page.querySelectorAll('span.label-rule')].find(
      candidate => candidate.textContent === 'Servers',
    );
    const row = servers?.closest('div.flex');
    await act(async () =>
      [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Change')?.click(),
    );
    expect(document.activeElement?.textContent).toBe('Edit');
  });

  it('stores nothing once the session ended under the credential test', async () => {
    mocks.imapTest = Promise.withResolvers();
    const page = await mount();
    await submitAll(page);

    endSession();
    await act(async () => mocks.imapTest?.resolve());
    expect(mocks.putAddress).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('goes nowhere once the session ended under the vault write', async () => {
    const write = Promise.withResolvers<void>();
    mocks.putAddress.mockImplementationOnce(() => write.promise);
    const page = await mount();
    await submitAll(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());

    endSession();
    await act(async () => write.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});
