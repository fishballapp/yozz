import { freshVault, type OpenedRecord, type RevisionMarks, type Vault } from '@yozz.app/vault';
import type { PutPrecondition, VaultRecordEnvelope } from '@yozz.app/vault-contract';
import { SEND_LEASE_RECORD_TYPE } from '../compose/draft-record.ts';
import type { VaultRecordApi } from './api.ts';

/** Every lease row seals this: nothing compares a lease's revisions. */
const LEASE_REVISION = 1;

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
};

/** `marks` are this device's high-water marks, the whole rollback defence; the caller owns their storage. */
export const createRecordStore = ({
  vault: rawVault,
  api,
  marks,
}: {
  readonly vault: Vault;
  readonly api: VaultRecordApi;
  readonly marks: RevisionMarks;
}): RecordStore => {
  const vault = freshVault(rawVault, marks);
  /**
   * A lease keeps no mark and consults none, though it is still sealed and bound to its row. It needs
   * no rollback defence: a replayed lease can only make a send look older, which leads to a banner and
   * never to a send. And marks are never cleared, so each send would leave one behind for good.
   */
  const vaultFor = (type: string) => (type === SEND_LEASE_RECORD_TYPE ? rawVault : vault);

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
    const id = await rawVault.recordId(type, naturalKey);
    const envelope = await api.get(type, id);
    if (!envelope) {
      return null;
    }
    return agreeing(
      envelope,
      await vaultFor(type).decryptRecord({
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
      agreeing(envelope, await vaultFor(type).decryptListedRecord(type, envelope)),
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
    if (input.type === SEND_LEASE_RECORD_TYPE) {
      const lease = await rawVault.encryptRecord({ ...input, revision: LEASE_REVISION });
      await api.put(lease, LEASE_REVISION, input.precondition);
      return;
    }
    const id = await rawVault.recordId(input.type, input.naturalKey);
    /**
     * A CAS update allocates from the row it replaces: marks are per device, and every device
     * reading that row agrees on its sequence. Anything below `n + 1` is still refused.
     */
    const base =
      input.precondition !== undefined &&
      input.precondition.expect === 'revision' &&
      input.precondition.revision !== null
        ? input.precondition.revision
        : ((await marks.highWaterMark(id)) ?? 0);
    const revision = base + 1;
    const encrypted = await vault.encryptRecord({ ...input, revision });
    await api.put(encrypted, revision, input.precondition);
    /**
     * Only on the store's yes, or a write that failed leaves this device refusing the row it still
     * has. A store that says yes and keeps the old row is refused; one that says no has told us.
     */
    await marks.raiseTo(id, revision);
  };

  const remove = async (type: string, naturalKey: string, ifRevision?: number): Promise<void> => {
    const id = await rawVault.recordId(type, naturalKey);
    await api.remove(type, id, ifRevision);
    /** The mark survives a delete: clearing it would let a store that withholds a row replay an old ciphertext. */
  };

  return { get, list, put, remove };
};
