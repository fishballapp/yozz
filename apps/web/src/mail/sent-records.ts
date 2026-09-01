import type { DraftRecord } from '../lib/drafts';
import { parseSentRecord, SENT_RECORD_TYPE, type SentRecord } from '../lib/sent';
import { VaultApiError } from '../vault/api';
import type { RecordStore } from '../vault/record-store';

/** Sent mail from an address with no mailbox; the vault holds the only copy, so never purged. */

/** The `absent` precondition makes a retry safe: the same Message-ID is refused rather than duplicated. */
export const storeSentRecord = async (store: RecordStore, record: SentRecord): Promise<void> => {
  try {
    await store.put({
      type: SENT_RECORD_TYPE,
      naturalKey: record.messageId,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'absent' },
    });
  } catch (error) {
    // Already written by an earlier attempt of this send: the success case.
    if (error instanceof VaultApiError && error.code === 'CONFLICT') return;
    throw error;
  }
};

/** Read back from the bytes: a formatted clock reading and the header it produced are not reliably the same string. */
const dateHeaderOf = (bytes: Uint8Array): string => {
  const headerBlock = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /^Date: (.*)$/m.exec(headerBlock)?.[1]?.trim() ?? '';
};

/** Built from the record the send froze, not from what the composer holds now. */
export const sentRecordFrom = (
  record: DraftRecord,
  messageId: string,
  bytes: Uint8Array,
  at: number,
): SentRecord => ({
  messageId,
  at,
  date: dateHeaderOf(bytes),
  from: record.from,
  to: record.to,
  cc: record.cc,
  subject: record.subject,
  body: record.body,
  ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
  ...(record.references === undefined ? {} : { references: [...record.references] }),
  bytes: bytes.toBase64(),
});

export const listSentRecords = async (store: RecordStore): Promise<readonly SentRecord[]> => {
  const rows = await store.list(SENT_RECORD_TYPE);
  return rows.flatMap(row => {
    const record = parseSentRecord(row.plaintext);
    return record === null ? [] : [record];
  });
};

export const hasSentRecord = async (store: RecordStore, messageId: string): Promise<boolean> =>
  (await store.get(SENT_RECORD_TYPE, messageId)) !== null;
