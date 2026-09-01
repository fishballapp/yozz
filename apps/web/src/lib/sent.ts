import { z } from 'zod';

/**
 * A message sent from an address with no mailbox; the vault is the only copy, so never purged.
 * Keyed by Message-ID, so a retried send is a no-op under the create's `absent` precondition.
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
  subject: z.string(),
  /** The markdown source, also the wire format's `text/plain` part. */
  body: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  /** The exact RFC 5322 bytes, base64. */
  bytes: z.string(),
});
export type SentRecord = z.infer<typeof sentRecordSchema>;

/** Total: a record this build cannot read is skipped. */
export const parseSentRecord = (plaintext: string): SentRecord | null => {
  try {
    const result = sentRecordSchema.safeParse(JSON.parse(plaintext) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
