import type { VaultApi } from '@yozz.app/mail/vault/api';
import { createRecordStore, type RecordStore } from '@yozz.app/mail/vault/record-store';
import type { Vault } from '@yozz.app/vault';
import { createIndexedDbRevisionMarks } from './revision-marks';

/** The record store an unlocked tab holds, over this device's revision marks in IndexedDB. */
export type DeviceRecordStore = RecordStore & {
  /** Lets go of the marks' database handle; the session ends with it. */
  readonly close: () => void;
};

export const openDeviceRecordStore = async ({
  userId,
  vault,
  api,
  idbFactory,
}: {
  readonly userId: string;
  readonly vault: Vault;
  readonly api: VaultApi;
  readonly idbFactory?: IDBFactory;
}): Promise<DeviceRecordStore> => {
  const marks = createIndexedDbRevisionMarks(userId, idbFactory);
  // Opened first, so a denied or missing IndexedDB rejects the unlock rather than failing on first read.
  await marks.open();
  return { ...createRecordStore({ vault, api, marks }), close: marks.close };
};
