import { buildMessage } from '@yozz.app/smtp';
import { resolveFolders } from '../addresses/mailboxes.ts';
import type { AddressRecord } from '../addresses/record.ts';
import type { MailConnectionFailure, Result, RunTask } from '../connection.ts';
import type { Attachment } from '../threads/thread.ts';
import { MAX_ATTACHMENT_BYTES } from './draft.ts';

export type OutgoingMail = {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  /** The markdown source, sent as the text part. */
  readonly text: string;
  readonly html: string;
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments: readonly Attachment[];
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

/** Built once and stored: a rebuild would mint a fresh Date and boundary, and the recipient would see two messages. */
export const buildOutgoing = (
  record: AddressRecord,
  mail: OutgoingMail,
): Result<Uint8Array, MailConnectionFailure> => {
  const attachmentBytes = mail.attachments.reduce((sum, { size }) => sum + size, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: { kind: 'error', detail: 'Attachments must total under 25 MiB.' } };
  }
  const attachments = mail.attachments.map(({ name, mimeType, content }) => {
    if (content === undefined) throw new Error(`${name} has no bytes to send`);
    return { filename: name, mimeType: mimeType ?? 'application/octet-stream', content };
  });
  return {
    ok: true,
    value: buildMessage({
      from: { address: record.address, name: record.senderName },
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      date: new Date(),
      messageId: mail.messageId,
      text: mail.text,
      html: mail.html,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      attachments,
    }),
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
