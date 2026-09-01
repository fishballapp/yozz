import { z } from 'zod';

/** A draft as one encrypted vault record, keyed by the random, stable `draftKey`. */
export const DRAFT_RECORD_TYPE = 'draft';

/** Replication bookkeeping, kept apart so writing it never bumps the content's version. */
export const DRAFT_MIRROR_RECORD_TYPE = 'draft-mirror';

/** Where a copy of something sits on a server. */
const locatorSchema = z.object({
  account: z.string().min(1),
  folder: z.string().min(1),
  uidValidity: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
});

/**
 * Present only while sending; every device refuses to edit or discard it. The phases are recovery
 * instructions after a crash; `submitting` is the one nobody can resolve automatically.
 */
const sendSchema = z.object({
  messageId: z.string().min(1),
  opId: z.string().min(1),
  state: z.enum(['submitting', 'submitted', 'copied']),
  /** A send not finished within `SEND_CLAIM_STALE_MS` did not finish; this is what says so. */
  claimedAt: z.number().int().nonnegative(),
  /** The exact RFC 5322 bytes, base64, so a resend is the same message. */
  bytes: z.string().optional(),
  /** An account's folder, or the vault for a send-only address. */
  target: z
    .union([
      z.object({ account: z.string().min(1), folder: z.string().min(1) }),
      z.literal('vault'),
    ])
    .optional(),
  /** Filled at the `copied` phase. */
  locator: locatorSchema.optional(),
});

export const draftRecordSchema = z.object({
  from: z.string().min(1),
  /** Chosen once at creation, then persisted. */
  ownerAccount: z.string().min(1).optional(),
  to: z.string(),
  cc: z.string(),
  bcc: z.string(),
  subject: z.string(),
  /** The markdown source, which is also the wire format's `text/plain` part. */
  body: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  /** Bumped on every content write; half of a `draftId`. */
  contentVersion: z.number().int().nonnegative(),
  /** Orders a draft among the mail around it. */
  updatedAt: z.number().int().nonnegative().optional(),
  /** Set by a soft delete: hidden, revivable for 30 days, then purged. */
  deletedAt: z.number().int().nonnegative().optional(),
  send: sendSchema.optional(),
  /**
   * A send whose SMTP answer was never seen, put aside so the draft can be edited. Discarding stays
   * refused; cleared when a sync finds the Message-ID in Sent or the person sends again.
   */
  unconfirmedSend: sendSchema.optional(),
  /** What the draft became, so its old id still resolves. */
  sentMessageId: z.string().optional(),
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

export const draftMirrorRecordSchema = z.object({
  /** The content version this mirror copy holds. */
  mirroredVersion: z.number().int().nonnegative(),
  locator: locatorSchema.optional(),
});
export type DraftMirrorRecord = z.infer<typeof draftMirrorRecordSchema>;

/** `<draftKey>@<contentVersion>`: the key is the stable handle, the pair is the precondition. */
export const draftIdOf = (draftKey: string, contentVersion: number) =>
  `${draftKey}@${contentVersion}`;

export const parseDraftId = (draftId: string): { key: string; version: number } | null => {
  const at = draftId.lastIndexOf('@');
  if (at <= 0) return null;
  const version = Number(draftId.slice(at + 1));
  return Number.isInteger(version) && version >= 0 ? { key: draftId.slice(0, at), version } : null;
};

/** Never derived from content. */
export const newDraftKey = () => crypto.randomUUID();

/** Total: a record this build cannot read is skipped. */
const parser =
  <T>(schema: z.ZodType<T>) =>
  (plaintext: string): T | null => {
    try {
      const result = schema.safeParse(JSON.parse(plaintext) as unknown);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  };

export const parseDraftRecord = parser(draftRecordSchema);
export const parseDraftMirrorRecord = parser(draftMirrorRecordSchema);

/** Longer than any SMTP attempt this client makes. */
export const SEND_CLAIM_STALE_MS = 5 * 60 * 1000;

/** Past `SEND_CLAIM_STALE_MS` any device may take a claim over: a duplicate is the accepted worst case, an unusable draft is not. */
export const heldSend = (record: DraftRecord, now: number) =>
  record.send !== undefined && now - record.send.claimedAt < SEND_CLAIM_STALE_MS
    ? record.send
    : undefined;

/**
 * The same claim rule the record writes use. A live claim is `'sending'`; a stale one is
 * `'unconfirmed'`, which a tab killed at `submitting` also leaves behind, still carrying `send`.
 */
export const openSendStateOf = (
  record: DraftRecord,
  now: number,
): 'sending' | 'unconfirmed' | null =>
  heldSend(record, now) !== undefined
    ? 'sending'
    : record.unconfirmedSend !== undefined || record.send !== undefined
      ? 'unconfirmed'
      : null;

/** How long a tombstoned draft stays revivable. */
export const DRAFT_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
