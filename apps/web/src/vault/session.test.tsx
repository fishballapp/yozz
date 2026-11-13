// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVault, VaultProvider } from './session';
import { forgetSignedIn } from './signed-in';
import type { UnlockedVaultSession } from './unlock';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The keys' round trip (the vault stamp they are saved against) is held until a test lets it go. */
const mocks = vi.hoisted(() => ({
  stamp: Promise.withResolvers<void>(),
  saveUnlockKeys: vi.fn(async (_keys: unknown) => {}),
  resumeSession: vi.fn(async (): Promise<UnlockedVaultSession | null> => null),
}));

vi.mock('./unlock', () => ({
  resumeSession: mocks.resumeSession,
  unlockKeysOf: async (session: { userId: string }) => {
    await mocks.stamp.promise;
    return { userId: session.userId };
  },
}));
vi.mock('./unlock-keys', () => ({
  saveUnlockKeys: mocks.saveUnlockKeys,
  forgetUnlockKeys: async () => {},
}));

const sessionOf = (userId: string) =>
  ({
    userId,
    store: { close: () => {} },
  }) as unknown as UnlockedVaultSession;

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  let vault: ReturnType<typeof useVault> | null = null;
  const Probe = () => {
    vault = useVault();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () =>
    root.render(
      <VaultProvider>
        <Probe />
      </VaultProvider>,
    ),
  );
  unmounts.push(() => act(async () => root.unmount()));
  return () => {
    if (vault === null) throw new Error('VaultProvider did not render');
    return vault;
  };
};

const hasSignedInCookie = () => document.cookie.split('; ').includes('yozz-signed-in=1');

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  forgetSignedIn(document);
  mocks.stamp = Promise.withResolvers();
  vi.clearAllMocks();
});

describe('VaultProvider', () => {
  it('saves the keys of the session it opened', async () => {
    const vault = await mount();
    act(() => vault().setSession(sessionOf('user-1')));
    await act(async () => mocks.stamp.resolve());
    expect(mocks.saveUnlockKeys).toHaveBeenCalledWith({ userId: 'user-1' });
  });

  it('saves no keys once the session locked under their round trip', async () => {
    const vault = await mount();
    act(() => vault().setSession(sessionOf('user-1')));
    await act(() => vault().lock());
    await act(async () => mocks.stamp.resolve());
    expect(mocks.saveUnlockKeys).not.toHaveBeenCalled();
  });

  it("saves only the next account's keys once it signed in under the round trip", async () => {
    const vault = await mount();
    act(() => vault().setSession(sessionOf('user-1')));
    act(() => vault().setSession(sessionOf('user-2')));
    await act(async () => mocks.stamp.resolve());
    expect(mocks.saveUnlockKeys.mock.calls).toEqual([[{ userId: 'user-2' }]]);
  });

  it('marks the browser signed in while a session is open, and unmarks it at lock', async () => {
    const vault = await mount();
    expect(hasSignedInCookie()).toBe(false);
    act(() => vault().setSession(sessionOf('user-1')));
    expect(hasSignedInCookie()).toBe(true);
    await act(() => vault().lock());
    expect(hasSignedInCookie()).toBe(false);
  });

  it('marks a browser whose session resumed on load', async () => {
    mocks.resumeSession.mockResolvedValueOnce(sessionOf('user-1'));
    await mount();
    expect(hasSignedInCookie()).toBe(true);
  });
});
