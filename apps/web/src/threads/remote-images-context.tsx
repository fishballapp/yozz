import { senderKeyOf } from '@yozz.app/mail/threads/thread';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
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
import { useVault } from '../vault/session';
import {
  forgetConsent,
  forgetSender,
  hasConsent,
  type ImageConsent,
  listTrustedSenders,
  MAX_REMEMBERED_ID_LENGTH,
  readConsents,
  rememberConsent,
  type TrustedSender,
  trustSender,
  withConsent,
  withoutConsent,
} from './remote-images';

type RemoteImagesValue = {
  /** False until this session's vault records are read; until then nothing is offered or loaded. */
  readonly isReady: boolean;
  readonly isConsented: (consent: ImageConsent) => boolean;
  /** Takes effect at once; the vault write behind it is best effort. */
  readonly consent: (consent: ImageConsent) => void;
  /** Takes effect at once; resolves once the vault has it too, and rejects when it does not. */
  readonly unconsent: (consent: ImageConsent) => Promise<void>;
  /** Oldest first. */
  readonly trustedSenders: readonly TrustedSender[];
  readonly trustOf: (address: string) => TrustedSender | undefined;
  /**
   * Each resolves once the vault has it, and rejects, changing nothing, when it does not. A trust
   * given again replaces the address's record, so one given through the warning widens it.
   */
  readonly trust: (sender: Pick<TrustedSender, 'address' | 'isVerifiedOnly'>) => Promise<void>;
  readonly forget: (address: string) => Promise<void>;
};

/**
 * A change this device made to the consent list that the vault has not confirmed: in flight, failed
 * (kept for the session), or never to be written (an id over the length ceiling).
 */
type ConsentChange = { readonly kind: 'add' | 'remove'; readonly consent: ImageConsent };

type State = {
  /** The session the rest belongs to: a lock or another sign-in starts from nothing. */
  readonly store: RecordStore | null;
  readonly isReady: boolean;
  /** The list as the vault last answered it, read or written. */
  readonly stored: readonly ImageConsent[];
  /** Replayed over `stored`, in order, for what the reader honours. */
  readonly pending: readonly ConsentChange[];
  readonly senders: readonly TrustedSender[];
};

const consentsOf = ({ stored, pending }: State): readonly ImageConsent[] =>
  pending.reduce(
    (consents, { kind, consent }) =>
      kind === 'add' ? withConsent(consents, consent) : withoutConsent(consents, consent),
    stored,
  );

const RemoteImagesContext = createContext<RemoteImagesValue | null>(null);

const emptyFor = (store: RecordStore | null): State => ({
  store,
  // Demo mode has no vault: memory is all there is, and it is ready at once.
  isReady: store === null,
  stored: [],
  pending: [],
  senders: [],
});

const withSender = (senders: readonly TrustedSender[], sender: TrustedSender) => [
  ...senders.filter(existing => senderKeyOf(existing.address) !== senderKeyOf(sender.address)),
  sender,
];

/** Over the unlocked session's vault; without one (demo mode), in memory. */
export const RemoteImagesProvider = ({ children }: { children: ReactNode }) => {
  const { session } = useVault();
  return (
    <RemoteImagesStoreProvider store={session?.store ?? null}>{children}</RemoteImagesStoreProvider>
  );
};

export const RemoteImagesStoreProvider = ({
  store,
  children,
}: {
  store: RecordStore | null;
  children: ReactNode;
}) => {
  const [held, setState] = useState<State>(() => emptyFor(store));
  // Never another session's answers, even for the render before the effect below resets them.
  const state = held.store === store ? held : emptyFor(store);
  // What a write that finds the stored list unreadable falls back to (`remote-images.ts`).
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Consent reads and writes run one at a time: two in flight on one device trip the vault's replay
   * guard, since a write raises this device's revision mark before the server holds that revision.
   * Their answers therefore arrive in order, each the base for the changes still behind it.
   */
  const consentQueue = useRef<Promise<unknown>>(Promise.resolve());
  const queued = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = consentQueue.current.then(task);
    consentQueue.current = run.catch(() => {});
    return run;
  }, []);

  useEffect(() => {
    setState(emptyFor(store));
    if (store === null) return;
    let isCancelled = false;
    void (async () => {
      const [consents, senders] = await Promise.allSettled([
        queued(() => readConsents(store)),
        listTrustedSenders(store),
      ]);
      if (isCancelled) return;
      // A vault that did not answer reads as nothing remembered: every message asks, as before.
      setState(current => ({
        ...current,
        isReady: true,
        stored: consents.status === 'fulfilled' ? consents.value.consents : current.stored,
        senders: senders.status === 'fulfilled' ? senders.value : [],
      }));
    })();
    return () => {
      isCancelled = true;
    };
  }, [store, queued]);

  /** Applies `update` only while `store` is still the session's. */
  const updateFor = useCallback(
    (store: RecordStore | null, update: (state: State) => State) =>
      setState(current => (current.store === store ? update(current) : current)),
    [],
  );

  /**
   * Shows `change` at once, then writes it behind every earlier one. Confirmed, the vault's answer
   * becomes the base and the change leaves `pending`; refused, it stays there for the session.
   */
  const apply = useCallback(
    async (
      change: ConsentChange,
      write: (store: RecordStore) => Promise<readonly ImageConsent[]>,
    ) => {
      updateFor(store, current => ({ ...current, pending: [...current.pending, change] }));
      if (store === null) return;
      const answer = await queued(() => write(store));
      updateFor(store, current => ({
        ...current,
        stored: answer,
        pending: current.pending.filter(candidate => candidate !== change),
      }));
    },
    [store, updateFor, queued],
  );

  const consent = useCallback(
    (consent: ImageConsent) => {
      const change: ConsentChange = { kind: 'add', consent };
      if (consent.messageId.length > MAX_REMEMBERED_ID_LENGTH) {
        // Honoured for the session, never written.
        updateFor(store, current => ({ ...current, pending: [...current.pending, change] }));
        return;
      }
      // ponytail: unwritten, this message asks again after a reload; the images it loaded already
      // have. Un-park if a toast is wanted for an offline consent.
      void apply(change, store =>
        rememberConsent(store, consent, () => consentsOf(stateRef.current)),
      ).catch(() => {});
    },
    [store, updateFor, apply],
  );

  const unconsent = useCallback(
    (consent: ImageConsent) =>
      apply({ kind: 'remove', consent }, store =>
        forgetConsent(store, consent, () => consentsOf(stateRef.current)),
      ),
    [apply],
  );

  const trust = useCallback(
    async ({ address, isVerifiedOnly }: Pick<TrustedSender, 'address' | 'isVerifiedOnly'>) => {
      const asked = { address, addedAt: Date.now(), isVerifiedOnly };
      const sender = store === null ? asked : await trustSender(store, asked);
      updateFor(store, current => ({ ...current, senders: withSender(current.senders, sender) }));
    },
    [store, updateFor],
  );

  const forget = useCallback(
    async (address: string) => {
      if (store !== null) await forgetSender(store, address);
      updateFor(store, current => ({
        ...current,
        senders: current.senders.filter(
          sender => senderKeyOf(sender.address) !== senderKeyOf(address),
        ),
      }));
    },
    [store, updateFor],
  );

  const { isReady, senders } = state;
  const consents = useMemo(() => consentsOf(state), [state]);
  const value = useMemo<RemoteImagesValue>(
    () => ({
      isReady,
      isConsented: candidate => hasConsent(consents, candidate),
      consent,
      unconsent,
      trustedSenders: senders,
      trustOf: address =>
        senders.find(sender => senderKeyOf(sender.address) === senderKeyOf(address)),
      trust,
      forget,
    }),
    [isReady, consents, senders, consent, unconsent, trust, forget],
  );

  return <RemoteImagesContext value={value}>{children}</RemoteImagesContext>;
};

export const useRemoteImages = (): RemoteImagesValue => {
  const value = use(RemoteImagesContext);
  if (value === null) throw new Error('useRemoteImages must be used inside <RemoteImagesProvider>');
  return value;
};
