// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressRecord } from '../addresses/record';
import { Connect } from './Connect';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The store as the form sees it, with a session a test can end, as a lock or a sign-in would. */
const mocks = vi.hoisted(() => ({
  generation: 0,
  putAddress: vi.fn<(record: AddressRecord) => Promise<void>>(async () => {}),
  navigate: vi.fn(async (_options: unknown) => {}),
  /** The IMAP credential test waits here. */
  imapTest: null as PromiseWithResolvers<void> | null,
}));

vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    identities: [],
    putAddress: mocks.putAddress,
    isDemo: false,
    watchSession: () => {
      const taken = mocks.generation;
      return () => mocks.generation === taken;
    },
  }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('../addresses/autoconfig', async importOriginal => ({
  ...(await importOriginal<typeof import('../addresses/autoconfig')>()),
  lookupMailServers: async () => ({
    status: 'found',
    config: {
      imap: { host: 'imap.example.com', port: 993 },
      smtp: { host: 'smtp.example.com', port: 465 },
      username: 'address',
      source: 'provider',
      sourceDomain: 'example.com',
    },
  }),
}));
vi.mock('../threads/sync', () => ({
  testImap: async () => {
    await mocks.imapTest?.promise;
    return { ok: true, value: undefined };
  },
}));
vi.mock('../compose/send', () => ({ testSmtp: async () => ({ ok: true, value: undefined }) }));

const endSession = () => {
  mocks.generation += 1;
};

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Connect />));
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

/** Typed and submitted straight from the form: the lookup runs inside the submission. */
const submit = async (page: HTMLElement) => {
  await act(async () => {
    type(page, 'connect-address', 'alice@example.com');
    type(page, 'connect-password', 'pw');
  });
  const form = page.querySelector('form');
  if (form === null) throw new Error('no form');
  await act(async () => form.requestSubmit());
};

beforeEach(() => {
  mocks.imapTest = null;
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.clearAllMocks();
});

describe('Connect', () => {
  it('stores a tested address and opens its mailbox', async () => {
    await submit(await mount());
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ params: { mailbox: 'alice@example.com' } }),
      ),
    );
    expect(mocks.putAddress).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'alice@example.com' }),
    );
  });

  it('stores nothing once the session ended under the credential test', async () => {
    mocks.imapTest = Promise.withResolvers();
    const page = await mount();
    await submit(page);

    endSession();
    await act(async () => mocks.imapTest?.resolve());
    expect(mocks.putAddress).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('goes nowhere once the session ended under the vault write', async () => {
    const write = Promise.withResolvers<void>();
    mocks.putAddress.mockImplementationOnce(() => write.promise);
    const page = await mount();
    await submit(page);
    await vi.waitFor(() => expect(mocks.putAddress).toHaveBeenCalled());

    endSession();
    await act(async () => write.resolve());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });
});
