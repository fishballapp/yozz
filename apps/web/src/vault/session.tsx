import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { resumeSession, type UnlockedVaultSession, unlockKeysOf } from './unlock';
import { forgetUnlockKeys, saveUnlockKeys } from './unlock-keys';

type VaultContextValue = {
  readonly session: UnlockedVaultSession | null;
  /** True until the mount-time resume has settled; the app gate waits on it. */
  readonly isResuming: boolean;
  /** One session per tab: an unlocked one is closed and its keys forgotten before the next opens. */
  readonly setSession: (session: UnlockedVaultSession) => void;
  /** Resolves once the persisted keys are gone; sign-out and reset await it. */
  readonly lock: () => Promise<void>;
};

const VaultContext = createContext<VaultContextValue | null>(null);

// Never inside a setState updater: React double-invokes them, and closing IndexedDB twice is wrong.
const close = (previous: UnlockedVaultSession) => {
  previous.store.close();
  return forgetUnlockKeys(previous.userId);
};

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

  // Read through a ref so `setSession` stays stable while still seeing the session it replaces.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const setSession = useCallback((next: UnlockedVaultSession) => {
    const previous = sessionRef.current;
    // A sign-in over an unlocked vault (an agent, a stale tab) must not leave the old account's
    // store open and its keys resumable. The mail store tears the old session down in its effect
    // cleanup, the same way it does for a lock.
    // A mode switch in Settings returns a session over the same store; only another one is closed.
    if (previous !== null && previous.store !== next.store) void close(previous).catch(() => {});
    setSessionState(next);
    // Best effort: the next reload asks again.
    unlockKeysOf(next)
      .then(keys => saveUnlockKeys(keys))
      .catch(() => {});
  }, []);

  const lock = useCallback(async () => {
    setSessionState(null);
    if (session === null) return;
    await close(session);
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
