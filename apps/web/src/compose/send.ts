import { buildMessage } from '@yozz.app/smtp';
import { resolveFolders } from '../addresses/mailboxes';
import type { AddressRecord } from '../addresses/record';
import { connectSmtp, type MailConnectionFailure, type Result } from '../relay/connection';
import type { LiveTask } from '../relay/live';
import type { Attachment } from '../threads/thread';

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

/** Gmail's ceiling; base64 adds a third on top. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type SentCopyFailure = MailConnectionFailure | { readonly kind: 'no-sent-mailbox' };

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/** The draft a message came from: how a send finds its own earlier copy on a retry. */

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

/** One SMTP connection, one submission of exactly these bytes. */
export const submitBytes = async (
  record: AddressRecord,
  bytes: Uint8Array,
  recipients: readonly string[],
): Promise<Result<void, MailConnectionFailure>> => {
  const conn = await connectSmtp(record.smtp);
  if (!conn.ok) return conn;
  const { client, close } = conn.value;
  try {
    const sent = await client.send({ from: record.address, to: recipients, data: bytes });
    if (!sent.ok) return { ok: false, error: { kind: 'smtp', reason: sent.reason } };
  } finally {
    await close();
  }
  return { ok: true, value: undefined };
};

/**
 * Searches the mailbox for its own Message-ID before appending, so a retry cannot duplicate.
 * Message-ID, not `X-Yozz-Draft`: Forward Email indexes only the headers IMAP names.
 */
export const storeSentCopy = async (
  run: Run,
  bytes: Uint8Array,
  messageId: string,
): Promise<Result<{ uidValidity: number; uid: number } | null, SentCopyFailure>> => {
  let missingSent = false;
  const result = await run({
    priority: 'user',
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

/** Open, authenticate, QUIT: what Connect runs before it stores an SMTP password. */
export const testSmtp = async (
  smtp: AddressRecord['smtp'],
): Promise<Result<void, MailConnectionFailure>> => {
  const conn = await connectSmtp(smtp);
  if (!conn.ok) return conn;
  await conn.value.close();
  return { ok: true, value: undefined };
};
