import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceDbError } from './device-db.ts';
import { createIndexedDbRevisionMarks } from './revision-marks.ts';

describe('IndexedDB RevisionMarks implementation', () => {
  let idbFactory: IDBFactory;

  beforeEach(() => {
    idbFactory = new IDBFactory();
  });

  it('reads undefined high-water mark for unseen record', async () => {
    const marks = createIndexedDbRevisionMarks('user-1', idbFactory);
    expect(await marks.highWaterMark('rec-1')).toBeUndefined();
    marks.close();
  });

  it('raises mark and persists monotonic high-water mark', async () => {
    const marks = createIndexedDbRevisionMarks('user-1', idbFactory);

    await marks.raiseTo('rec-1', 5);
    expect(await marks.highWaterMark('rec-1')).toBe(5);

    // Stale or lower candidate does not decrease mark
    await marks.raiseTo('rec-1', 3);
    expect(await marks.highWaterMark('rec-1')).toBe(5);

    // Higher candidate updates mark
    await marks.raiseTo('rec-1', 9);
    expect(await marks.highWaterMark('rec-1')).toBe(9);

    marks.close();
  });

  it('strictly isolates marks by userId', async () => {
    const marksUser1 = createIndexedDbRevisionMarks('user-1', idbFactory);
    const marksUser2 = createIndexedDbRevisionMarks('user-2', idbFactory);

    await marksUser1.raiseTo('rec-shared-id', 10);
    await marksUser2.raiseTo('rec-shared-id', 20);

    expect(await marksUser1.highWaterMark('rec-shared-id')).toBe(10);
    expect(await marksUser2.highWaterMark('rec-shared-id')).toBe(20);

    marksUser1.close();
    marksUser2.close();
  });

  it('persists marks across separate instance handles', async () => {
    const handle1 = createIndexedDbRevisionMarks('user-1', idbFactory);
    await handle1.raiseTo('rec-persist', 42);
    handle1.close();

    const handle2 = createIndexedDbRevisionMarks('user-1', idbFactory);
    expect(await handle2.highWaterMark('rec-persist')).toBe(42);
    handle2.close();
  });

  it('fails closed when database connection is closed or errors', async () => {
    const marks = createIndexedDbRevisionMarks('user-1', idbFactory);
    marks.close();

    await expect(marks.highWaterMark('rec-1')).rejects.toThrow(DeviceDbError);
    await expect(marks.raiseTo('rec-1', 5)).rejects.toThrow(DeviceDbError);
  });
});
