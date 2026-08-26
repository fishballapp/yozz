/**
 * The half of same-row replay that `vault.ts` cannot do: refusing.
 *
 * A record carries its revision inside the ciphertext, so every read already
 * reports the revision it was written at. What turns that report into a refusal
 * is a **high-water mark per record** — the newest revision this device has
 * seen — and comparing against it needs state that survives a reload and does
 * not come from the store being checked.
 *
 * `freshVault` is that comparison, wrapped around a `Vault` and returning a
 * `Vault`. It is deliberately the same shape as `@yozz.app/tls`'s `pinnedValidator`:
 * the inner call runs first and its failure is returned untouched, so a
 * freshness verdict can never admit a record that failed to authenticate.
 *
 * ## Why the marks are the caller's, and why this file is not where they live
 *
 * They outlive a page load and they belong to an account, which is the same
 * reason `@yozz.app/tls` owns neither its session store nor its pin store. A store
 * this package held would have to be a store this package could test without,
 * and the whole value of `@yozz.app/vault` is that it is correct whether or not
 * anything around it behaves.
 *
 * ## Why learning on read is safe here, when learning a PIN on validate is not
 *
 * `@yozz.app/tls` refuses to learn a pin inside the validator, because certificates
 * are PUBLIC: anyone on the path can replay one, it validates, and the store
 * takes a key from a stranger. **A revision is not public.** It comes out from
 * under AES-GCM, so only a holder of `recordKey` could have produced it, and
 * the only revisions in existence are ones this user's own client wrote. A
 * hostile store can replay an old one, which is exactly what the mark catches,
 * and it cannot manufacture a new one to push the mark past reality. So check
 * and learn are one operation here rather than two, and that asymmetry is a
 * property of the input rather than a relaxation of the rule.
 *
 * ## A write advances the mark, and it has to
 *
 * Advancing only on reads looks safer and fails the primary threat outright:
 * rotate a credential to revision 8, and a store that keeps serving 7 is
 * believed forever, because a device that never saw 8 has no mark above 7. That
 * IS the rollback this exists to stop, so `encryptRecord` advances the mark to
 * the revision it just sealed.
 *
 * The cost is a false alarm when a write is sealed and the store never takes
 * it: the mark says 8, the store still answers 7, and the next read refuses.
 * **That refusal is accurate** — the client really did write 8 and the store
 * really does not have it — and retrying is not blocked, because the check
 * refuses only a revision BELOW the mark, so re-sealing 8 passes.
 */

import { VaultError } from './bytes.ts';
import type { OpenedRecord, Vault } from './vault.ts';

/**
 * Per-record freshness state, owned by the caller. `undefined` means this
 * device has never seen the record, which is trust-on-first-use — the same
 * accepted limit as the TOFU pin, and unavoidable: a first read has nothing to
 * compare against.
 *
 * **`raiseTo` is a MAX, not a set, and the name is the contract.** It must
 * store `max(current, revision)` and never let a mark recede. An earlier
 * version called it `advance` and documented it as safe to implement as a blind
 * write, on the reasoning that `check` only ever calls it upward. That
 * reasoning is false the moment two operations on one id overlap: both read the
 * same mark before either write lands, both pass the staleness test against
 * that snapshot, and the lower write can land last. Measured, not theorised —
 * two concurrent seals at revisions 9 and 8 left the mark at 8, after which a
 * replay of revision 8 is accepted, which is the rollback this file exists to
 * stop.
 *
 * Two tabs sharing one persisted store is the ordinary case, not an exotic one,
 * so the invariant belongs in the store rather than in a caller's discipline. A
 * high-water mark that can recede is the type lying about itself.
 */
export type RevisionMarks = {
  readonly highWaterMark: (id: string) => Promise<number | undefined>;
  readonly raiseTo: (id: string, revision: number) => Promise<void>;
};

export const freshVault = (vault: Vault, marks: RevisionMarks): Vault => {
  /**
   * Equal passes: re-reading the revision this device already knows is the
   * ordinary case, and re-sealing it is how a failed write is retried. Only
   * BELOW is a replay.
   */
  const check = async (id: string, revision: number): Promise<void> => {
    const mark = await marks.highWaterMark(id);
    if (mark !== undefined && revision < mark) {
      throw new VaultError(
        'stale',
        `record ${id} is revision ${revision}, behind the ${mark} this device has already seen`,
      );
    }
    /**
     * Skipping the call when the mark already covers it is IO avoidance, not
     * the safety property — `raiseTo` is a max and holds the invariant on its
     * own, which is what makes an interleaved call harmless rather than a
     * downgrade.
     */
    if (mark === undefined || revision > mark) await marks.raiseTo(id, revision);
  };

  const checked = async <T extends OpenedRecord>(id: string, opened: T): Promise<T> => {
    await check(id, opened.revision);
    return opened;
  };

  return {
    recordId: vault.recordId,

    encryptRecord: async item => {
      const record = await vault.encryptRecord(item);
      /**
       * After the seal, so a revision the door rejected never touches the mark,
       * and keyed on the id the seal actually used rather than a second
       * derivation of it.
       */
      await check(record.id, item.revision);
      return record;
    },

    decryptRecord: async item =>
      checked(await vault.recordId(item.type, item.naturalKey), await vault.decryptRecord(item)),

    decryptListedRecord: async (type, listed) =>
      checked(listed.id, await vault.decryptListedRecord(type, listed)),
  };
};

/**
 * Marks that live as long as the tab — for tests, and for a caller that has not
 * wired persistence yet.
 *
 * **It refuses a replay within one page load and forgets every mark on
 * reload**, so each fresh load starts at trust-on-first-use for every record.
 * That is strictly weaker than the defence is meant to be and it is not a
 * placeholder to leave in: a store only has to wait for a refresh. The real
 * implementation persists, which is why `RevisionMarks` is async.
 */
export const inMemoryRevisionMarks = (): RevisionMarks => {
  const marks = new Map<string, number>();
  return {
    highWaterMark: id => Promise.resolve(marks.get(id)),
    raiseTo: (id, revision) => {
      const current = marks.get(id);
      // The max the name promises. A blind `set` here is the downgrade a
      // concurrent pair of writes produces, and the reference implementation is
      // what every real one will be copied from.
      if (current === undefined || revision > current) marks.set(id, revision);
      return Promise.resolve();
    },
  };
};
