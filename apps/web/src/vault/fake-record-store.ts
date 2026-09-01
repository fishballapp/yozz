import { VaultApiError } from './api';
import type { RecordStore } from './record-store';

/**
 * A vault that ENFORCES the preconditions, for tests about compare-and-swap.
 *
 * A store that accepted every write would let those tests pass while two devices quietly
 * overwrote each other, which is the one outcome the real store exists to prevent.
 */
export const fakeRecordStore = () => {
  const rows = new Map<string, { plaintext: string; revision: number }>();
  const key = (type: string, naturalKey: string) => `${type} ${naturalKey}`;
  const refuse = () => {
    throw new VaultApiError('CONFLICT', 'Record revision is stale', 409);
  };
  const store: RecordStore = {
    get: async (type, naturalKey) => {
      const row = rows.get(key(type, naturalKey));
      return row === undefined ? null : { plaintext: row.plaintext, revision: row.revision };
    },
    list: async type =>
      [...rows].flatMap(([id, row]) => {
        const [rowType, naturalKey] = id.split(' ');
        return rowType === type && naturalKey !== undefined ? [{ ...row, naturalKey }] : [];
      }),
    put: async ({ type, naturalKey, plaintext, precondition }) => {
      const id = key(type, naturalKey);
      const existing = rows.get(id);
      if (precondition?.expect === 'absent' && existing !== undefined) refuse();
      if (
        precondition?.expect === 'revision' &&
        (existing === undefined || existing.revision !== precondition.revision)
      ) {
        refuse();
      }
      rows.set(id, { plaintext, revision: (existing?.revision ?? 0) + 1 });
    },
    remove: async (type, naturalKey) => {
      rows.delete(key(type, naturalKey));
    },
    close: () => {},
  };
  return { store, rows, key };
};
