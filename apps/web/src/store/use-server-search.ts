import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import {
  type FolderMatches,
  flagAfterWrite,
  foundAfterMoves,
  withFound,
} from '@yozz.app/mail/threads/found';
import type { PendingChange } from '@yozz.app/mail/threads/reconcile';
import {
  askServers,
  createServerSearch,
  type MoreOn,
  planOf,
  type SearchOn,
  type ServerSearch,
} from '@yozz.app/mail/threads/server-search';
import type { FolderSummaries, MailboxSummaries } from '@yozz.app/mail/threads/summaries';
import type { FlagTarget, MovedCopy } from '@yozz.app/mail/threads/sync';
import { type RefObject, useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ActivityTracker } from '../relay/activity';
import type { RunOn } from '../relay/live';
import { isDemo } from '../ui/chrome';

/**
 * Server search over the live connections: what the box is asking, and what every search has found
 * beyond the synced windows, kept for this session so a message opened from one stays openable.
 */
export const useServerSearch = ({
  mailboxesRef,
  userIdRef,
  syncRunsRef,
  bindRunOn,
  activity,
}: {
  mailboxesRef: RefObject<readonly InboundAddress[]>;
  userIdRef: RefObject<string | null>;
  syncRunsRef: RefObject<ReadonlyMap<string, { readonly promise: Promise<void> }>>;
  bindRunOn: () => RunOn;
  activity: ActivityTracker;
}) => {
  const [serverSearch, setServerSearch] = useState<ServerSearch | null>(null);
  const [found, setFound] = useState<MailboxSummaries>({});

  const landFound = useCallback(
    (address: string, matches: FolderMatches) =>
      setFound(current => ({
        ...current,
        [address]: withFound(current[address] ?? {}, matches),
      })),
    [],
  );

  const searchOn = useCallback<SearchOn<InboundAddress>>(
    async (mailbox, { folders, query, signal, onMatches }) => {
      if (import.meta.env.DEV && isDemo()) {
        const end = activity.begin({ effect: 'read', priority: 'user' });
        const { demoServerSearch } = await import('../dev/fixtures');
        return demoServerSearch(
          mailbox.address,
          query.terms.map(({ text }) => text),
          signal,
          onMatches,
        ).finally(end);
      }
      const userId = userIdRef.current;
      if (userId === null) {
        return { ok: false, error: { kind: 'error', detail: "You're signed out" } };
      }
      const runOn = bindRunOn();
      // The whole search, for the activity bar: each command is its own task, and a quick one would
      // never be old enough to show.
      const end = activity.begin({ effect: 'read', priority: 'user' });
      try {
        const [{ searchMailbox }, { createMailCache }] = await Promise.all([
          import('@yozz.app/mail/threads/search'),
          import('../threads/cache'),
        ]);
        // A link opened on a new device: a folder no sync has read yet holds nothing to find, and
        // answering so would read as no such mail.
        await syncRunsRef.current.get(mailbox.address)?.promise;
        return await searchMailbox({
          run: runOn(mailbox),
          cache: createMailCache(userId, mailbox.address),
          folders,
          query,
          signal,
          onMatches,
        });
      } finally {
        end();
      }
    },
    [activity, bindRunOn, syncRunsRef, userIdRef],
  );

  const moreOn = useCallback<MoreOn<InboundAddress>>(
    async (mailbox, { previous, signal }) => {
      const end = activity.begin({ effect: 'read', priority: 'user' });
      try {
        if (import.meta.env.DEV && isDemo()) {
          const { demoMoreMatches } = await import('../dev/fixtures');
          return demoMoreMatches(previous);
        }
        const userId = userIdRef.current;
        if (userId === null) {
          return { ok: false, error: { kind: 'error', detail: "You're signed out" } };
        }
        const runOn = bindRunOn();
        const [{ readMoreMatches }, { createMailCache }] = await Promise.all([
          import('@yozz.app/mail/threads/search'),
          import('../threads/cache'),
        ]);
        return await readMoreMatches({
          run: runOn(mailbox),
          cache: createMailCache(userId, mailbox.address),
          previous,
          signal,
        });
      } finally {
        end();
      }
    },
    [activity, bindRunOn, userIdRef],
  );

  // Made once: it holds the search in hand, and `bindRunOn` moves on with the session.
  const searchOnRef = useRef(searchOn);
  searchOnRef.current = searchOn;
  const moreOnRef = useRef(moreOn);
  moreOnRef.current = moreOn;
  const [search] = useState(() =>
    createServerSearch<InboundAddress>({
      mailboxes: () => mailboxesRef.current,
      searchOn: (mailbox, request) => searchOnRef.current(mailbox, request),
      moreOn: (mailbox, request) => moreOnRef.current(mailbox, request),
      onChange: setServerSearch,
      onMatches: landFound,
    }),
  );

  return {
    serverSearch,
    found,
    search,
    /** Asks once, for a tool that waits for the whole answer; the box's own search is left alone. */
    askAndWait: useCallback(
      async (text: string) => {
        const plan = planOf(text, mailboxesRef.current);
        if (plan === null) return { answers: [], failed: [] };
        return askServers({
          plan,
          searchOn,
          // The tool reads the list straight after, so what it found must be in it by then.
          onMatches: (address, matches) => flushSync(() => landFound(address, matches)),
        });
      },
      [landFound, mailboxesRef, searchOn],
    ),
    /** A found copy's state after a write that reached it, since no sync will refresh it. */
    afterWrite: useCallback(
      (
        address: string,
        change: PendingChange,
        targets: readonly FlagTarget[],
        moves: readonly MovedCopy[],
      ) =>
        setFound(current => {
          const held: FolderSummaries | undefined = current[address];
          if (held === undefined) return current;
          return {
            ...current,
            [address]:
              change.kind === 'move'
                ? foundAfterMoves(held, moves)
                : flagAfterWrite(held, targets, change),
          };
        }),
      [],
    ),
    forget: useCallback((address?: string) => {
      setFound(current => {
        if (address === undefined) return {};
        const { [address]: _, ...rest } = current;
        return rest;
      });
    }, []),
  };
};
