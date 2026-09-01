import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { resumeSession, type UnlockedVaultSession, unlockKeysOf } from './unlock.ts';
import { forgetUnlockKeys, saveUnlockKeys } from './unlock-keys.ts';

type VaultContextValue = {
  readonly session: UnlockedVaultSession | null;
  /** True until the mount-time resume has settled; the app gate waits on it. */
  readonly isResuming: boolean;
  readonly setSession: (session: UnlockedVaultSession) => void;
  /** Resolves once the persisted keys are gone; sign-out and reset await it. */
  readonly lock: () => Promise<void>;
};

const VaultContext = createContext<VaultContextValue | null>(null);

/** The keys live in React state and are persisted (non-extractable) in IndexedDB; `lock` forgets them. */
export const VaultProvider = ({ children }: { children: ReactNode }) => {
  const [session, setSessionState] = useState<UnlockedVaultSession | null>(null);
  const [isResuming, setIsResuming] = useState(true);

  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const resumed = await resumeSession();
        if (isCancelled) {
          resumed?.store.close();
          return;
        }
        if (resumed !== null) setSessionState(resumed);
      } catch {
        // A wrap that no longer opens, or no IndexedDB: locked, not broken.
      } finally {
        if (!isCancelled) setIsResuming(false);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  const setSession = useCallback((next: UnlockedVaultSession) => {
    setSessionState(next);
    // Best effort: the next reload asks again.
    unlockKeysOf(next)
      .then(keys => saveUnlockKeys(keys))
      .catch(() => {});
  }, []);

  // Never inside a setState updater: React double-invokes them, and closing IndexedDB twice is wrong.
  const lock = useCallback(async () => {
    setSessionState(null);
    if (session === null) return;
    session.store.close();
    await forgetUnlockKeys(session.userId);
    // The mail store's session→null cleanup clears the cache, bumping the sync generation first.
  }, [session]);

  const value = useMemo<VaultContextValue>(
    () => ({ session, isResuming, setSession, lock }),
    [session, isResuming, setSession, lock],
  );

  return <VaultContext value={value}>{children}</VaultContext>;
};

export const useVault = (): VaultContextValue => {
  const value = use(VaultContext);
  if (value === null) throw new Error('useVault must be used inside <VaultProvider>');
  return value;
};
