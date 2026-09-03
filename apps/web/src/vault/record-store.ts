import { freshVault, type OpenedRecord, type Vault } from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import type { VaultApi } from './api';
import { createIndexedDbRevisionMarks } from './revision-marks';

/** The clear-text revision is not the one sealed inside the ciphertext; the client writes both from one number. */
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
    /** Omitted is last-write-wins; stated, a refusal comes back as `VaultApiError` with code `CONFLICT`. */
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
  /** Async so a denied or missing IndexedDB rejects the unlock rather than failing on first read. */
  await marks.open();
  const vault = freshVault(rawVault, marks);

  /**
   * The column is a claim, the sealed number is the fact. A NULL column predates the column and is
   * skipped. On top of the high-water mark, which keeps refusing replays.
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
   * Allocated here from this device's mark, not passed in: after a `remove` the mark stays and
   * `get` returns `null`, so a caller cannot learn the number a recreate must exceed.
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
     * A CAS update allocates from the row it replaces. Marks are per device, so allocating from the
     * mark lets a losing device's mark exceed the winning revision and refuse every later read of
     * it. Anything below `n + 1` is still refused.
     */
    const base =
      input.precondition !== undefined &&
      input.precondition.expect === 'revision' &&
      input.precondition.revision !== null
        ? input.precondition.revision
        : (mark ?? 0);
    // Encrypting through freshVault raises the high-water mark before the network PUT.
    const revision = base + 1;
    const encrypted = await vault.encryptRecord({ ...input, revision });
    await api.put(encrypted, revision, input.precondition);
  };

  const remove = async (type: string, naturalKey: string, ifRevision?: number): Promise<void> => {
    const id = await vault.recordId(type, naturalKey);
    await api.remove(type, id, ifRevision);
    /** The mark survives a delete: clearing it would let a store that withholds a row replay an old ciphertext. */
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
