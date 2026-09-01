import { z } from 'zod';

/**
 * A message this device sent from an address with no mailbox to keep it in. The vault is then the
 * only copy that exists anywhere, so unlike a draft tombstone it is never purged.
 *
 * The natural key is the Message-ID: a send that is retried after a lost response writes the same
 * key, and the create's `absent` precondition turns the second write into a no-op rather than a
 * second copy.
 */
export const SENT_RECORD_TYPE = 'sent';

export const sentRecordSchema = z.object({
  messageId: z.string().min(1),
  /** When this device handed the bytes to SMTP. */
  at: z.number().int().nonnegative(),
  /**
   * The message's own `Date` header, verbatim. Kept because it is half of what identifies a
   * message: when this same mail turns up in a real mailbox later, the two copies collapse into
   * one row only if the fingerprints match, and the fingerprint reads this string.
   */
  date: z.string(),
  from: z.string().min(1),
  to: z.string(),
  cc: z.string(),
  subject: z.string(),
  /** The markdown source, which is what the wire format's `text/plain` part holds too. */
  body: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  /** The exact RFC 5322 bytes, base64: what went out, not a rendering of what went out. */
  bytes: z.string(),
});
export type SentRecord = z.infer<typeof sentRecordSchema>;

/** Total: a record this build cannot read is skipped, never thrown on. */
export const parseSentRecord = (plaintext: string): SentRecord | null => {
  try {
    const result = sentRecordSchema.safeParse(JSON.parse(plaintext) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
