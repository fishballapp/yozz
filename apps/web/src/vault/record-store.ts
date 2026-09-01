import { freshVault, type OpenedRecord, type Vault } from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import type { VaultApi } from './api.ts';
import { createIndexedDbRevisionMarks } from './revision-marks.ts';

/**
 * The store served a row whose clear-text revision is not the one sealed inside its ciphertext.
 * Nothing legitimate produces that: the client writes both from the same number.
 */
export class VaultStoreDisagreementError extends Error {
  constructor(id: string) {
    super(`Vault record ${id} states a revision its ciphertext does not`);
    this.name = 'VaultStoreDisagreementError';
  }
}

export type RecordStore = {
  readonly get: (type: string, naturalKey: string) => Promise<OpenedRecord | null>;
  readonly list: (
    type: string,
  ) => Promise<readonly (OpenedRecord & { readonly naturalKey: string })[]>;
  readonly put: (input: {
    readonly type: string;
    readonly naturalKey: string;
    readonly plaintext: string;
    /**
     * What this write claims about the row it replaces. Omitted is the pre-CAS last-write-wins;
     * a record two devices can edit at once states one, and a refusal comes back as
     * `VaultApiError` with code `CONFLICT`.
     */
    readonly precondition?: PutPrecondition;
  }) => Promise<void>;
  readonly remove: (type: string, naturalKey: string, ifRevision?: number) => Promise<void>;
  readonly close: () => void;
};

export const createRecordStore = async ({
  userId,
  rawVault,
  api,
  idbFactory,
}: {
  readonly userId: string;
  readonly rawVault: Vault;
  readonly api: VaultApi;
  readonly idbFactory?: IDBFactory;
}): Promise<RecordStore> => {
  const marks = createIndexedDbRevisionMarks(userId, idbFactory);
  /**
   * Async, and that is the point: opening here means a caller cannot obtain a
   * store whose marks were never reachable. A denied or missing IndexedDB
   * rejects the unlock instead of yielding a session that fails on first read —
   * the difference between refusing and pretending.
   */
  await marks.open();
  const vault = freshVault(rawVault, marks);

  /**
   * The column is a claim, the sealed number is the fact, and a store that disagrees with itself
   * is hostile rather than merely wrong: it is offering a revision the ciphertext does not
   * attest. A NULL column is a row written before the column existed and has nothing to say, so
   * it is skipped — the next write to that row fills it. This is a check ON TOP of the
   * high-water mark, which keeps doing its own job of refusing replays.
   */
  const agreeing = <T extends OpenedRecord>(envelope: VaultRecordEnvelope, opened: T): T => {
    if (envelope.revision !== null && envelope.revision !== opened.revision) {
      throw new VaultStoreDisagreementError(envelope.id);
    }
    return opened;
  };

  const get = async (type: string, naturalKey: string): Promise<OpenedRecord | null> => {
    const id = await vault.recordId(type, naturalKey);
    const envelope = await api.get(type, id);
    if (!envelope) {
      return null;
    }
    return agreeing(
      envelope,
      await vault.decryptRecord({
        type,
        naturalKey,
        ciphertext: envelope.ciphertext,
      }),
    );
  };

  const list = async (
    type: string,
  ): Promise<readonly (OpenedRecord & { readonly naturalKey: string })[]> => {
    return Array.fromAsync(api.list(type), async envelope =>
      agreeing(envelope, await vault.decryptListedRecord(type, envelope)),
    );
  };

  /**
   * The revision is allocated HERE, from this device's own high-water mark, and
   * is deliberately not a parameter.
   *
   * A caller cannot compute it. After a client-initiated `remove` the mark
   * stays — correctly, because clearing it would reopen the omission-then-replay
   * hole a hostile store could drive — but `get` then returns `null`, so there
   * is no way to learn the number a recreate has to exceed. Writing the same
   * natural key again at revision 1 was refused as `stale`, and "remove this
   * account and add it back" is a primary flow for this product.
   *
   * `mark + 1` is always above anything this device has seen, so the write is
   * accepted and any older ciphertext replayed afterwards is not. It also
   * removes the whole class of caller-picked revisions: there is no longer a
   * wrong value to pass.
   */
  const put = async (input: {
    readonly type: string;
    readonly naturalKey: string;
    readonly plaintext: string;
    readonly precondition?: PutPrecondition;
  }): Promise<void> => {
    const id = await vault.recordId(input.type, input.naturalKey);
    const mark = await marks.highWaterMark(id);
    /**
     * A CAS update allocates from the ROW it is replacing, not from this device's mark.
     *
     * Marks are per device, so two devices editing one record allocate independently: one seals
     * 10 (mark 9), the other seals 3 (mark 2) and WINS. Encrypting raises the mark either way, so
     * the loser's mark is 10 while the authoritative record is 3 — and every later read of the
     * winner is refused as a replay. The device is locked out of a record it can legitimately
     * read, which is the one failure this whole mechanism exists to prevent, arriving by another
     * door.
     *
     * Allocating from the row makes every device agree on the sequence: both write `n + 1`, so
     * the loser's mark equals the winner's revision and reading it passes. Replay protection is
     * untouched — anything BELOW that is still refused. Nothing to base on (a create, or a
     * pre-CAS row) keeps `mark + 1`.
     */
    const base =
      input.precondition !== undefined &&
      input.precondition.expect === 'revision' &&
      input.precondition.revision !== null
        ? input.precondition.revision
        : (mark ?? 0);
    // Encrypting through freshVault raises the high-water mark before the network PUT
    const revision = base + 1;
    const encrypted = await vault.encryptRecord({ ...input, revision });
    await api.put(encrypted, revision, input.precondition);
  };

  const remove = async (type: string, naturalKey: string, ifRevision?: number): Promise<void> => {
    const id = await vault.recordId(type, naturalKey);
    await api.remove(type, id, ifRevision);
    /**
     * The mark SURVIVES a delete, deliberately. Clearing it would let a store
     * that simply withholds a row reset this device to trust-on-first-use and
     * then replay an old ciphertext. `put` allocates above the surviving mark,
     * so a recreate still works.
     */
  };

  const close = () => {
    marks.close();
  };

  return {
    get,
    list,
    put,
    remove,
    close,
  };
};
