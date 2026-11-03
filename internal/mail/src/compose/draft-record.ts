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

/** A file a record names; its bytes are in R2 under `id`, sealed to it. */
export const fileReferenceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
  kind: z.enum(['pdf', 'image', 'archive', 'sheet', 'other']),
});
export type FileReference = z.infer<typeof fileReferenceSchema>;

/**
 * A message frozen by its claim: `head` (base64) is every byte but the attachments' bodies, and each
 * splice says where a file's body goes. A new field, not `bytes` and optional splices: a client that
 * knows neither stops, where one that knew `bytes` alone would send empty attachments.
 */
export const frozenMessageSchema = z.object({
  head: z.string(),
  splices: z.array(z.object({ at: z.number().int().nonnegative(), fileId: z.string().min(1) })),
});
export type FrozenMessage = z.infer<typeof frozenMessageSchema>;

/**
 * Present only while sending; every device refuses to edit or discard it. The phases are recovery
 * instructions after a crash. `submitting` is the one nobody can resolve automatically, and
 * `unconfirmed` says SMTP's answer to the end of the message was lost: the person settles it.
 */
const sendSchema = z.object({
  messageId: z.string().min(1),
  /** Fresh per claim; names the claim's lease row. */
  opId: z.string().min(1),
  state: z.enum(['submitting', 'unconfirmed', 'submitted', 'copied']),
  /** When this claim was taken. With no lease renewed since, `heldSend` judges it from here. */
  claimedAt: z.number().int().nonnegative(),
  /** So a resend is the same message. */
  message: frozenMessageSchema.optional(),
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
  /** Absent reads as none. A save that does not state it keeps what the record has. */
  attachments: z.array(fileReferenceSchema).optional(),
  /** Bumped on every content write; half of a `draftId`. */
  contentVersion: z.number().int().nonnegative(),
  /** Orders a draft among the mail around it. */
  updatedAt: z.number().int().nonnegative().optional(),
  /** Set by a soft delete: hidden, revivable for 30 days, then purged. */
  deletedAt: z.number().int().nonnegative().optional(),
  send: sendSchema.optional(),
  /**
   * A send whose SMTP answer was never seen, put aside so the draft can be edited. Discarding stays
   * refused until a sync finds the Message-ID in Sent or the person sends again.
   */
  unconfirmedSend: sendSchema.optional(),
  /** What the draft became, so its old id still resolves. */
  sentMessageId: z.string().optional(),
  /** It went out with no copy kept in Sent, which is what a repeated `yozz send` reports. */
  isSentWithoutCopy: z.literal(true).optional(),
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

/** Every file a draft record names, a tombstone's too: what it holds, and what its sends froze. */
export const fileIdsOfDraft = (record: DraftRecord): readonly string[] => [
  ...(record.attachments ?? []).map(({ id }) => id),
  ...[record.send, record.unconfirmedSend].flatMap(
    send => send?.message?.splices.map(({ fileId }) => fileId) ?? [],
  ),
];

export const parseDraftMirrorRecord = parser(draftMirrorRecordSchema);

/**
 * A running send renews this row, named by its claim's `opId`, so a renewal never bumps the version
 * the phases compare-and-swap on nor re-uploads the frozen head. One row per claim: a row removed
 * and written again from another device would read as a replay of an older one.
 */
export const SEND_LEASE_RECORD_TYPE = 'send-lease';

export const parseSendLease = parser(z.object({ renewedAt: z.number().int().nonnegative() }));

/** Under a minute, so a hidden tab's one-a-minute timers still beat at every wake-up. */
export const SEND_LEASE_RENEW_MS = 45 * 1000;

/** Survives one lost renewal and a minute of a slow write. */
export const SEND_LEASE_MS = 3 * 60 * 1000;

/**
 * Past this a send stops renewing, so one stuck on some unbounded wait cannot hold its draft for
 * ever. It only ends the lease, never the attempt. Twice 25 MiB at 128 kbit/s, and the answers.
 */
export const SEND_LEASE_CEILING_MS = 2 * 60 * 60 * 1000;

/** How long a send that has ended waits to remove its lease. Past this the sweep has it. */
export const SEND_LEASE_CLEANUP_MS = 3 * 1000;

/**
 * A send still running: its claim or its lease is recent. Nobody may take it over. An `unconfirmed`
 * one is not running. `renewedAt` is what the lease row said when it was read.
 */
export const heldSend = (record: DraftRecord, renewedAt: number | undefined, now: number) => {
  const { send } = record;
  if (send === undefined || send.state === 'unconfirmed') return undefined;
  return now - Math.max(send.claimedAt, renewedAt ?? 0) < SEND_LEASE_MS ? send : undefined;
};

/**
 * Content no write may change: a send running, one nobody saw the answer to, or one SMTP accepted.
 * A lapsed lease unfreezes nothing, so no plain Send can deliver it again under a new Message-ID.
 */
export const isFrozenBySend = ({ send }: DraftRecord) => send !== undefined;

/**
 * A send whose SMTP answer nobody saw: recorded as such, put aside so the draft can be edited, or a
 * `submitting` claim nobody is running any more. The person settles it, or the message turning up
 * in a Sent folder does.
 */
export const unconfirmedSendOf = (
  record: DraftRecord,
  renewedAt: number | undefined,
  now: number,
) => {
  const { send } = record;
  if (send === undefined) return record.unconfirmedSend;
  if (send.state === 'unconfirmed') return send;
  return send.state === 'submitting' && heldSend(record, renewedAt, now) === undefined
    ? send
    : undefined;
};

/**
 * What the person is told. `'sending'`: it is running, here or elsewhere. `'unconfirmed'`: only
 * `submitting` is ambiguous, so a claim that stopped there is the question, which a tab killed there
 * also leaves behind. `'accepted'`: SMTP took it and only the copy in Sent is left, so it must never
 * go out again.
 */
export const openSendStateOf = (
  record: DraftRecord,
  renewedAt: number | undefined,
  now: number,
): 'sending' | 'unconfirmed' | 'accepted' | null => {
  if (heldSend(record, renewedAt, now) !== undefined) return 'sending';
  if (unconfirmedSendOf(record, renewedAt, now) !== undefined) return 'unconfirmed';
  return record.send === undefined ? null : 'accepted';
};

/** How long a tombstoned draft stays revivable. */
export const DRAFT_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
