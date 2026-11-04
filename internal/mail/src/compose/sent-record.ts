import { z } from 'zod';
import { fileReferenceSchema, frozenMessageSchema } from './draft-record.ts';

/**
 * A message sent from an address with no mailbox; the vault is the only copy, so it is never
 * purged. Keyed by Message-ID, so a retried send is a no-op under the create's `absent`
 * precondition.
 */
export const SENT_RECORD_TYPE = 'sent';

export const sentRecordSchema = z.object({
  messageId: z.string().min(1),
  /** When this device handed the bytes to SMTP. */
  at: z.number().int().nonnegative(),
  /** The message's own `Date` header, verbatim: half of the fingerprint that collapses this with a later mailbox copy. */
  date: z.string(),
  from: z.string().min(1),
  to: z.string(),
  cc: z.string(),
  /** Absent when nobody was blind-copied. Free text like `to`; the message's own bytes never name it. */
  bcc: z.string().optional(),
  subject: z.string(),
  /** The markdown source, also the wire format's `text/plain` part. */
  body: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  /** The message as its claim froze it; its files stay in R2, named here, so they count against the cap. */
  message: frozenMessageSchema.optional(),
  attachments: z.array(fileReferenceSchema).optional(),
});
export type SentRecord = z.infer<typeof sentRecordSchema>;

/** Every file a sent record names. */
export const fileIdsOfSent = (record: SentRecord): readonly string[] => [
  ...(record.attachments ?? []).map(({ id }) => id),
  ...(record.message?.splices.map(({ fileId }) => fileId) ?? []),
];

/** Total: a record this build cannot read is skipped. */
export const parseSentRecord = (plaintext: string): SentRecord | null => {
  try {
    const result = sentRecordSchema.safeParse(JSON.parse(plaintext) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
