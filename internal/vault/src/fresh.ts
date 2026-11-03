import { VaultError } from './bytes.ts';
import type { OpenedRecord, Vault } from './vault.ts';

/**
 * Per-record freshness state, owned by the caller. `undefined` means never seen (trust on first
 * use). `raiseTo` MUST store `max(current, revision)`: two overlapping writes on one id can call it
 * out of order.
 */
export type RevisionMarks = {
  readonly highWaterMark: (id: string) => Promise<number | undefined>;
  readonly raiseTo: (id: string, revision: number) => Promise<void>;
};

export const freshVault = (vault: Vault, marks: RevisionMarks): Vault => {
  // Equal passes: a tab behind its sibling seals the revision the sibling just confirmed, and hears the conflict from the store.
  const refuseBehindMark = async (id: string, revision: number): Promise<number | undefined> => {
    const mark = await marks.highWaterMark(id);
    if (mark !== undefined && revision < mark) {
      throw new VaultError(
        'stale',
        `record ${id} is revision ${revision}, behind the ${mark} this device has already seen`,
      );
    }
    return mark;
  };

  const checked = async <T extends OpenedRecord>(id: string, opened: T): Promise<T> => {
    const mark = await refuseBehindMark(id, opened.revision);
    if (mark === undefined || opened.revision > mark) await marks.raiseTo(id, opened.revision);
    return opened;
  };

  return {
    recordId: vault.recordId,

    encryptRecord: async item => {
      const record = await vault.encryptRecord(item);
      // Raises nothing: a seal may never reach the store. Whoever writes it raises the mark on the store's yes.
      await refuseBehindMark(record.id, item.revision);
      return record;
    },

    decryptRecord: async item =>
      checked(await vault.recordId(item.type, item.naturalKey), await vault.decryptRecord(item)),

    decryptListedRecord: async (type, listed) =>
      checked(listed.id, await vault.decryptListedRecord(type, listed)),

    encryptFile: vault.encryptFile,
    decryptFile: vault.decryptFile,

    localKey: vault.localKey,
  };
};

/** For tests. Forgets every mark on reload, so it is not a defence. */
export const inMemoryRevisionMarks = (): RevisionMarks => {
  const marks = new Map<string, number>();
  return {
    highWaterMark: id => Promise.resolve(marks.get(id)),
    raiseTo: (id, revision) => {
      const current = marks.get(id);
      if (current === undefined || revision > current) marks.set(id, revision);
      return Promise.resolve();
    },
  };
};
