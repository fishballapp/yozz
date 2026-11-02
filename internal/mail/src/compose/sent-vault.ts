import { VaultApiError } from '../vault/api.ts';
import type { RecordStore } from '../vault/record-store.ts';
import type { DraftRecord, FrozenMessage } from './draft-record.ts';
import { parseSentRecord, SENT_RECORD_TYPE, type SentRecord } from './sent-record.ts';

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

/**
 * Read back from the head: a formatted clock reading and the header it produced are not reliably the
 * same string. Up to the first blank line, the headers, however long a recipient list made them.
 */
const dateHeaderOf = (message: FrozenMessage): string => {
  const headers = new TextDecoder()
    .decode(Uint8Array.fromBase64(message.head))
    .split('\r\n\r\n', 1)[0];
  return /^Date: (.*)$/m.exec(headers ?? '')?.[1]?.trim() ?? '';
};

/** Built from the record the send froze, not from what the composer holds now. */
export const sentRecordFrom = (
  record: DraftRecord,
  messageId: string,
  message: FrozenMessage,
  at: number,
): SentRecord => ({
  messageId,
  at,
  date: dateHeaderOf(message),
  from: record.from,
  to: record.to,
  cc: record.cc,
  subject: record.subject,
  body: record.body,
  ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
  ...(record.references === undefined ? {} : { references: [...record.references] }),
  message,
  ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
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
