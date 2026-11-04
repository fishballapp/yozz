/** A tab return syncs an address only if its last sync started at least this long ago. */
export const RETURN_SYNC_FRESH_MS = 2 * 60 * 1000;

/**
 * The mailboxes a tab return should sync at `now`: those never synced, or whose last sync started
 * `RETURN_SYNC_FRESH_MS` or more ago. Keyed on the start, not the finish, because a sync reads the
 * server after it starts: its start bounds how old what it read can be.
 */
export const staleMailboxes = <A extends { readonly address: string }>(
  mailboxes: readonly A[],
  lastStartedAt: ReadonlyMap<string, number>,
  now: number,
): A[] =>
  mailboxes.filter(mailbox => {
    const started = lastStartedAt.get(mailbox.address);
    return started === undefined || now - started >= RETURN_SYNC_FRESH_MS;
  });
