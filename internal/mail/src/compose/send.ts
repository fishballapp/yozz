import { renderHtml } from '@tanstack/markdown/html';
import { buildMessageParts, encodeAttachmentBody, spliceMessage } from '@yozz.app/smtp';
import { MAX_CIPHERTEXT_BYTES } from '@yozz.app/vault-contract';
import { resolveFolders } from '../addresses/mailboxes.ts';
import { type AddressRecord, isInbound } from '../addresses/record.ts';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import { addressList, MAX_ATTACHMENT_BYTES } from './draft.ts';
import type { DraftRecord, FileReference, FrozenMessage } from './draft-record.ts';

export type OutgoingMail = {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  /** The markdown source, sent as the text part beside its rendered HTML. */
  readonly text: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments: readonly FileReference[];
};

/** To, Cc, Bcc, each once (case-insensitively; some servers reject a repeat). `RCPT TO` is where Bcc exists. */
export const envelopeRecipients = (
  mail: Pick<OutgoingMail, 'to' | 'cc' | 'bcc'>,
): readonly string[] => {
  const seen = new Set<string>();
  return [...mail.to, ...mail.cc, ...mail.bcc].filter(address => {
    const key = address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export type SentCopyFailure = MailConnectionFailure | { readonly kind: 'no-sent-mailbox' };

/** The message with its files left out; with none, `head` is the whole message. */
export type OutgoingMessage = {
  readonly head: Uint8Array<ArrayBuffer>;
  readonly splices: FrozenMessage['splices'];
};

/** Built once and stored: a rebuild would mint a fresh Date and boundary, and the recipient would see two messages. */
export const buildOutgoing = (
  record: AddressRecord,
  mail: OutgoingMail,
): Result<OutgoingMessage, MailConnectionFailure> => {
  const attachmentBytes = mail.attachments.reduce((sum, { size }) => sum + size, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: { kind: 'error', detail: 'Attachments must total under 25 MiB.' } };
  }
  const { head, splices } = buildMessageParts({
    from: { address: record.address, name: record.senderName },
    to: mail.to,
    cc: mail.cc,
    subject: mail.subject,
    date: new Date(),
    messageId: mail.messageId,
    text: mail.text,
    // A whole document: a bare fragment is what filters see from templating tools
    // (docs/knowledge/email-deliverability.md).
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${renderHtml(mail.text)}</body></html>`,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    attachments: mail.attachments.map(({ name, mimeType }) => ({
      filename: name,
      mimeType: mimeType ?? 'application/octet-stream',
    })),
  });
  return {
    ok: true,
    value: {
      head,
      splices: splices.map((at, index) => {
        const file = mail.attachments[index];
        if (file === undefined) throw new Error(`No file for attachment ${index}`);
        return { at, fileId: file.id };
      }),
    },
  };
};

/** `@yozz.app/vault`'s record: base64 of iv ‖ AES-GCM(tag) over the JSON of revision, key, plaintext. */
const fitsVaultRecord = (naturalKey: string, plaintext: string): boolean => {
  const sealedBytes =
    12 +
    16 +
    new TextEncoder().encode(
      JSON.stringify([String(Number.MAX_SAFE_INTEGER), naturalKey, plaintext]),
    ).length;
  return Math.ceil(sealedBytes / 3) * 4 <= MAX_CIPHERTEXT_BYTES;
};

type DraftFields = Pick<
  DraftRecord,
  'from' | 'to' | 'cc' | 'bcc' | 'subject' | 'body' | 'inReplyTo' | 'references' | 'attachments'
>;

/**
 * The claim that freezes a draft: the message built once, and where its Sent copy goes. A claim keeps
 * the message but for its files in the draft's vault record, so text too long for one record is said
 * here, before anything is written, rather than as a failed claim.
 */
export const claimOf = (
  identity: AddressRecord,
  draftKey: string,
  record: DraftFields,
  now: number,
): Result<NonNullable<DraftRecord['send']>, MailConnectionFailure> => {
  const messageId = `<${crypto.randomUUID()}@${record.from.slice(record.from.indexOf('@') + 1)}>`;
  const built = buildOutgoing(identity, {
    to: addressList(record.to),
    cc: addressList(record.cc),
    bcc: addressList(record.bcc),
    subject: record.subject,
    text: record.body,
    messageId,
    ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
    ...(record.references === undefined ? {} : { references: record.references }),
    attachments: record.attachments ?? [],
  });
  if (!built.ok) return built;
  const send = {
    messageId,
    opId: crypto.randomUUID(),
    state: 'submitting',
    claimedAt: now,
    message: { head: built.value.head.toBase64(), splices: built.value.splices },
    // The logical folder; the name is resolved against LIST at copy time.
    target: isInbound(identity) ? { account: identity.address, folder: 'sent' } : 'vault',
  } satisfies NonNullable<DraftRecord['send']>;
  // The record at its largest, as phase (2) leaves it: if that fits, every write before it does.
  const claimed = {
    ...record,
    contentVersion: Number.MAX_SAFE_INTEGER,
    updatedAt: now,
    send: {
      ...send,
      locator: {
        account: record.from,
        folder: 'sent',
        uidValidity: 2 ** 32,
        uid: 2 ** 32,
      },
    },
  };
  if (!fitsVaultRecord(draftKey, JSON.stringify(claimed))) {
    return {
      ok: false,
      error: {
        kind: 'error',
        detail: 'This message’s text is too long to send. Shorten it or trim the quoted thread.',
      },
    };
  }
  return { ok: true, value: send };
};

/** Each file's bytes when a step needs them, by id; `null` or a throw means it cannot be read. */
export type ReadFile = (fileId: string) => Promise<Uint8Array | null>;

/** The bytes a frozen message always was: the head with each file's body at its splice. */
export const assembleMessage = async (
  message: FrozenMessage,
  readFile: ReadFile,
  nameOf: (fileId: string) => string,
): Promise<Result<Uint8Array, MailConnectionFailure>> => {
  const unreadable = (fileId: string) =>
    ({
      ok: false,
      error: { kind: 'error', detail: `Couldn’t download ${nameOf(fileId)}` },
    }) as const;
  const bodies: Uint8Array[] = [];
  for (const { fileId } of message.splices) {
    const file = await readFile(fileId).catch(() => null);
    if (file === null) return unreadable(fileId);
    bodies.push(encodeAttachmentBody(file));
  }
  return {
    ok: true,
    value: spliceMessage(
      {
        head: Uint8Array.fromBase64(message.head),
        splices: message.splices.map(({ at }) => at),
      },
      bodies,
    ),
  };
};

/**
 * The submission's end was written and its answer never read: the server may have taken the
 * message, so it is neither sent nor refused. Every other failure happened before the end of
 * `DATA`, when nothing can have gone out.
 */
export const isUnconfirmedSubmission = (failure: MailConnectionFailure): boolean =>
  failure.kind === 'smtp' && failure.reason.kind === 'unconfirmed';

/**
 * Searches the mailbox for its own Message-ID before appending, so a retry cannot duplicate.
 * Message-ID, not `X-Yozz-Draft`: Forward Email indexes only the headers IMAP names.
 */
export const storeSentCopy = async (
  run: RunTask,
  bytes: Uint8Array,
  messageId: string,
): Promise<Result<{ uidValidity: number; uid: number } | null, SentCopyFailure>> => {
  let missingSent = false;
  const result = await run({
    priority: 'user',
    effect: 'write',
    // The search makes a second run safe.
    retry: true,
    run: async client => {
      const folders = await resolveFolders(client);
      if (!folders.ok) return folders;
      const sent = folders.value.sent;
      if (sent === undefined) {
        missingSent = true;
        return { ok: true, value: null };
      }
      const selected = await client.select(sent);
      if (!selected.ok) return { ok: false, error: { kind: 'imap', reason: selected.reason } };
      const found = await client.uidSearchHeader('Message-ID', messageId);
      const already = found.ok ? found.value.at(-1) : undefined;
      if (already !== undefined) {
        const uidValidity = selected.value.uidValidity;
        return {
          ok: true,
          value: uidValidity === null ? null : { uidValidity, uid: already },
        };
      }
      const appended = await client.append(sent, bytes, ['\\Seen']);
      if (!appended.ok) return { ok: false, error: { kind: 'imap', reason: appended.reason } };
      return { ok: true, value: appended.value };
    },
  });
  if (missingSent) return { ok: false, error: { kind: 'no-sent-mailbox' } };
  return result;
};
