import { z } from 'zod';

/**
 * A draft, as one encrypted vault record. The natural key is the `draftKey`: random, minted once
 * and stable for the draft's whole life, including across the mirror's changing Message-IDs and
 * across a send. Nothing derived from the content names it, because the content is what changes.
 *
 * Why the server and not `localStorage` (`lib/draft-store.ts`, which this replaces for YOZZ's own
 * drafts): a draft you started on a laptop is the one thing in this product that has to survive
 * moving to a phone, and a device-local draft cannot. The server still cannot read it.
 */
export const DRAFT_RECORD_TYPE = 'draft';

/** Replication bookkeeping, kept apart so writing it never bumps the content's version. */
export const DRAFT_MIRROR_RECORD_TYPE = 'draft-mirror';

/** Where a copy of something sits on a server, as a draft record stores it. */
const locatorSchema = z.object({
  account: z.string().min(1),
  folder: z.string().min(1),
  uidValidity: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
});

/**
 * A send in flight, and the phase it reached. Present ONLY while sending: every device refuses to
 * edit or discard a draft that has one, so the bytes SMTP was handed cannot be thrown away or
 * edited underneath the send.
 *
 * The phases are recovery instructions after a crash, which is why the bytes are stored rather
 * than rebuilt: a resend must be the same message, not a new one that happens to say the same
 * thing. `submitting` is the only ambiguous state — nobody knows whether SMTP accepted — and it
 * is the one the user is asked about rather than resolved automatically.
 */
const sendSchema = z.object({
  messageId: z.string().min(1),
  opId: z.string().min(1),
  state: z.enum(['submitting', 'submitted', 'copied']),
  /**
   * When the claim was taken. A claim with no end is a draft nobody can edit, discard or send on
   * ANY device — so a stale one must be releasable, and this is what says it is stale. A send
   * that has not finished within `SEND_CLAIM_STALE_MS` did not finish: the tab was closed, or the
   * device went away mid-request.
   */
  claimedAt: z.number().int().nonnegative(),
  /**
   * The exact RFC 5322 bytes, base64, so a resend is the same message rather than a new one that
   * merely says the same thing. Absent until the send state machine lands and fills it; a claim
   * without them excludes other devices but cannot itself be resumed.
   */
  bytes: z.string().optional(),
  /** Where the Sent copy goes: an account's folder, or the vault for a send-only address. */
  target: z
    .union([
      z.object({ account: z.string().min(1), folder: z.string().min(1) }),
      z.literal('vault'),
    ])
    .optional(),
  /** Filled at the `copied` phase: where the Sent copy actually landed. */
  locator: locatorSchema.optional(),
});

export const draftRecordSchema = z.object({
  from: z.string().min(1),
  /** Which account's Drafts and Sent hold this draft. Chosen once at creation, then persisted. */
  ownerAccount: z.string().min(1).optional(),
  to: z.string(),
  cc: z.string(),
  bcc: z.string(),
  subject: z.string(),
  /** The markdown source, which is what the wire format's `text/plain` part is too. */
  body: z.string(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  threadId: z.string().optional(),
  /**
   * Bumped on every content write, and half of a `draftId`. A save names the version it read and
   * the vault refuses a stale one, so two devices editing at once cannot silently overwrite each
   * other — the loser is told, and asks the person.
   */
  contentVersion: z.number().int().nonnegative(),
  /** When the content was last written. What orders a draft among the mail around it. */
  updatedAt: z.number().int().nonnegative().optional(),
  /** Set by a soft delete. Hidden everywhere, revivable for 30 days, then purged. */
  deletedAt: z.number().int().nonnegative().optional(),
  send: sendSchema.optional(),
  /**
   * A send whose SMTP answer was never seen, put aside so the draft can be edited again.
   *
   * The frozen bytes stay: discarding is still refused, because nobody knows whether that message
   * reached anyone. It is cleared when a later sync finds the Message-ID in a Sent folder (the
   * send did complete, and the draft becomes the tombstone it should have been) or when the
   * person sends again. Never automatically resent.
   */
  unconfirmedSend: sendSchema.optional(),
  /** Set when the send completed: what the draft became, so its old id still resolves. */
  sentMessageId: z.string().optional(),
});
export type DraftRecord = z.infer<typeof draftRecordSchema>;

export const draftMirrorRecordSchema = z.object({
  /** The content version this mirror copy holds; older than the draft's means it is stale. */
  mirroredVersion: z.number().int().nonnegative(),
  locator: locatorSchema.optional(),
});
export type DraftMirrorRecord = z.infer<typeof draftMirrorRecordSchema>;

/**
 * `<draftKey>@<contentVersion>` — the handle a write names, so the vault can refuse a stale one.
 * The key alone is the STABLE handle (it survives every edit); the pair is the precondition.
 */
export const draftIdOf = (draftKey: string, contentVersion: number) =>
  `${draftKey}@${contentVersion}`;

export const parseDraftId = (draftId: string): { key: string; version: number } | null => {
  const at = draftId.lastIndexOf('@');
  if (at <= 0) return null;
  const version = Number(draftId.slice(at + 1));
  return Number.isInteger(version) && version >= 0 ? { key: draftId.slice(0, at), version } : null;
};

/** A fresh, unguessable draft key. Never derived from content: the content is what changes. */
export const newDraftKey = () => crypto.randomUUID();

/** Total: a record this build cannot read is skipped, never thrown on. */
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

/**
 * How long a send claim may sit before any device may release it. Longer than any SMTP attempt
 * this client makes, short enough that a crashed tab does not strand a draft for an afternoon.
 */
export const SEND_CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * The claim that is still worth honouring, if any.
 *
 * A claim excludes every device from editing, discarding or sending — so one left behind by a tab
 * that died mid-send would freeze the draft for ever, and the person could neither send it nor
 * throw it away. Past `SEND_CLAIM_STALE_MS` any device may take it over. The trade is the
 * design's: a duplicate at the recipient is the accepted worst case, an unusable draft is not.
 */
export const heldSend = (record: DraftRecord, now: number) =>
  record.send !== undefined && now - record.send.claimedAt < SEND_CLAIM_STALE_MS
    ? record.send
    : undefined;

/**
 * What the composer says above a draft whose send has not finished — the same claim rule the
 * record writes use, so the banner and the store never disagree about one draft.
 *
 * A live claim is `'sending'` and offers nothing: some device is mid-flight and the person has
 * nothing to decide. Once the claim goes stale it becomes `'unconfirmed'` — the question only a
 * person can settle — which is also what a tab killed at `submitting` leaves behind. That case
 * arrives still carrying `send`, never `unconfirmedSend`, because the only writer of
 * `unconfirmedSend` is the Back to editing button this state exists to render.
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

/** How long a tombstoned draft stays revivable before a sync task purges it. */
export const DRAFT_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
