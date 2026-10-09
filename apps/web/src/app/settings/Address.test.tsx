// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressRecord } from '../../addresses/record';
import { Address } from './Address';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ALICE: AddressRecord = {
  address: 'alice@example.com',
  senderName: 'Alice',
  smtp: { host: 'smtp.example.com', port: 465, username: 'alice', password: 'pw' },
};

/**
 * The store's addresses, re-rendering the page when they change, as `useMail` would, and a session a
 * test can end, as a lock or a sign-in would.
 */
const mocks = vi.hoisted(() => ({
  generation: 0,
  identities: [] as readonly AddressRecord[],
  listeners: new Set<() => void>(),
  removeAddress: vi.fn<(address: string) => Promise<void>>(),
  setSenderName: vi.fn<(address: string, senderName: string) => Promise<void>>(),
  navigate: vi.fn(async (_options: unknown) => {}),
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
      removeAddress: mocks.removeAddress,
      setSenderName: mocks.setSenderName,
      watchSession: () => {
        const taken = mocks.generation;
        return () => mocks.generation === taken;
      },
    }),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ address: ALICE.address }),
  useNavigate: () => mocks.navigate,
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

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

const confirmRemoval = async () => {
  await act(async () => button('Remove address').click());
  await act(async () => button('Remove address').click());
};

beforeEach(() => {
  setIdentities([ALICE]);
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.clearAllMocks();
});

describe('Address', () => {
  it('saves the display name on blur and shows a refusal', async () => {
    mocks.setSenderName.mockRejectedValue(new Error('The vault refused'));
    const page = await mount();
    const input = page.querySelector<HTMLInputElement>('#address-sender-name');
    if (input === null) throw new Error('no display name field');

    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Al');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });

    expect(mocks.setSenderName).toHaveBeenCalledWith(ALICE.address, 'Al');
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('The vault refused');
  });

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
    expect(page.textContent).toContain(ALICE.address);
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

  it('stays on the page with the refusal when the vault keeps the address', async () => {
    mocks.removeAddress.mockRejectedValue(new Error('The vault refused'));
    const page = await mount();

    await confirmRemoval();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(page.querySelector('[role="alert"]')?.textContent).toBe('The vault refused');
    expect(button('Remove address').disabled).toBe(false);
  });
});
