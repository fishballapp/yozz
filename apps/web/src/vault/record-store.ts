import { freshVault, type OpenedRecord, type Vault } from '@yozz.app/vault';
import type { VaultApi } from './api.ts';
import { createIndexedDbRevisionMarks } from './revision-marks.ts';

export type RecordStore = {
  readonly get: (type: string, naturalKey: string) => Promise<OpenedRecord | null>;
  readonly list: (
    type: string,
  ) => Promise<readonly (OpenedRecord & { readonly naturalKey: string })[]>;
  readonly put: (input: {
    readonly type: string;
    readonly naturalKey: string;
    readonly plaintext: string;
  }) => Promise<void>;
  readonly remove: (type: string, naturalKey: string) => Promise<void>;
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

  const get = async (type: string, naturalKey: string): Promise<OpenedRecord | null> => {
    const id = await vault.recordId(type, naturalKey);
    const envelope = await api.get(type, id);
    if (!envelope) {
      return null;
    }
    return vault.decryptRecord({
      type,
      naturalKey,
      ciphertext: envelope.ciphertext,
    });
  };

  const list = async (
    type: string,
  ): Promise<readonly (OpenedRecord & { readonly naturalKey: string })[]> => {
    return Array.fromAsync(api.list(type), envelope => vault.decryptListedRecord(type, envelope));
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
  }): Promise<void> => {
    const id = await vault.recordId(input.type, input.naturalKey);
    const mark = await marks.highWaterMark(id);
    // Encrypting through freshVault raises the high-water mark before the network PUT
    const encrypted = await vault.encryptRecord({ ...input, revision: (mark ?? 0) + 1 });
    await api.put(encrypted);
  };

  const remove = async (type: string, naturalKey: string): Promise<void> => {
    const id = await vault.recordId(type, naturalKey);
    await api.remove(type, id);
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
