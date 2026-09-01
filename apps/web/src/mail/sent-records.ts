import type { DraftRecord } from '../lib/drafts';
import { parseSentRecord, SENT_RECORD_TYPE, type SentRecord } from '../lib/sent';
import { VaultApiError } from '../vault/api';
import type { RecordStore } from '../vault/record-store';

/**
 * Sent mail from an address with no mailbox behind it. The vault holds the only copy, so these
 * records are written once and never purged.
 */

/**
 * Writes the copy if it is not already there. The precondition is what makes a retry safe: a send
 * resumed after a lost response writes the same Message-ID, and the second write is refused
 * rather than making a second copy of the same message.
 */
export const storeSentRecord = async (store: RecordStore, record: SentRecord): Promise<void> => {
  try {
    await store.put({
      type: SENT_RECORD_TYPE,
      naturalKey: record.messageId,
      plaintext: JSON.stringify(record),
      precondition: { expect: 'absent' },
    });
  } catch (error) {
    // Already written by an earlier attempt of this same send: that IS the success case.
    if (error instanceof VaultApiError && error.code === 'CONFLICT') return;
    throw error;
  }
};

/**
 * The `Date` header as the message itself spells it, read back from the bytes rather than
 * re-derived: a formatted clock reading and the header it produced are not reliably the same
 * string, and this one has to match what a mailbox will hand back later.
 */
const dateHeaderOf = (bytes: Uint8Array): string => {
  const headerBlock = new TextDecoder().decode(bytes.subarray(0, 4096));
  return /^Date: (.*)$/m.exec(headerBlock)?.[1]?.trim() ?? '';
};

/**
 * The vault's copy of what a draft became. Built from the record the send froze, so it says what
 * went out rather than what the composer happens to hold now.
 */
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
