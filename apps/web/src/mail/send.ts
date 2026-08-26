import { buildMessage } from '@yozz.app/smtp';
import { type AddressRecord, isInbound } from '../lib/addresses';
import type { Attachment } from '../lib/thread';
import { connectSmtp, type MailConnectionFailure, type Result } from './connection';
import type { LiveTask } from './live';
import { resolveFolders } from './mailboxes';

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
  readonly attachments: readonly Attachment[];
};

/**
 * Who the server is told to deliver to: To, then Cc, then Bcc, each address once.
 *
 * The envelope is the whole reason a blind copy works — it carries every recipient regardless of
 * what the headers say, and `RCPT TO` is where Bcc exists at all. Deduplicated case-insensitively
 * because an address on two lines is one delivery, and some servers reject the repeat outright.
 */
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

/** Gmail's ceiling, which every other big provider matches or beats; base64 adds a third on top. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type SentCopyFailure = MailConnectionFailure | { readonly kind: 'no-sent-mailbox' };

/**
 * A send-only address has no mailbox to keep a copy in; an inbound one gets the accepted bytes
 * `APPEND`ed to its Sent folder. The copy failing never fails the send: the message is gone.
 */
export type SendOutcome = {
  readonly sentCopy: Result<void, SentCopyFailure> | 'send-only';
};

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

const storeSentCopy = async (
  run: Run,
  message: Uint8Array,
): Promise<Result<void, SentCopyFailure>> => {
  let missingSent = false;
  const result = await run({
    priority: 'user',
    // An APPEND re-run would duplicate the Sent copy.
    retry: false,
    run: async client => {
      const folders = await resolveFolders(client);
      if (!folders.ok) return folders;
      if (folders.value.sent === undefined) {
        missingSent = true;
        return { ok: true, value: undefined };
      }
      const appended = await client.append(folders.value.sent, message, ['\\Seen']);
      if (!appended.ok) return { ok: false, error: { kind: 'imap', reason: appended.reason } };
      return { ok: true, value: undefined };
    },
  });
  if (missingSent) return { ok: false, error: { kind: 'no-sent-mailbox' } };
  return result;
};

/**
 * One SMTP connection per send; then the Sent copy over the account's live IMAP connection.
 * `imap` is required when the record is inbound.
 */
export const sendMail = async (
  record: AddressRecord,
  mail: OutgoingMail,
  imap: Run | null,
): Promise<Result<SendOutcome, MailConnectionFailure>> => {
  if (isInbound(record) && imap === null) {
    throw new Error('sendMail requires a live IMAP run for inbound addresses');
  }
  const attachmentBytes = mail.attachments.reduce((sum, { size }) => sum + size, 0);
  if (attachmentBytes > MAX_ATTACHMENT_BYTES)
    return {
      ok: false,
      error: { kind: 'error', detail: 'Attachments must total under 25 MiB.' },
    };
  const conn = await connectSmtp(record.smtp);
  if (!conn.ok) return conn;
  const { client, close } = conn.value;
  const attachments = mail.attachments.map(({ name, mimeType, content }) => {
    if (content === undefined) throw new Error(`${name} has no bytes to send`);
    return { filename: name, mimeType: mimeType ?? 'application/octet-stream', content };
  });
  const data = buildMessage({
    from: { address: record.address, name: record.senderName },
    to: mail.to,
    cc: mail.cc,
    subject: mail.subject,
    date: new Date(),
    messageId: mail.messageId,
    text: mail.text,
    html: mail.html,
    inReplyTo: mail.inReplyTo,
    attachments,
  });
  try {
    const sent = await client.send({
      from: record.address,
      to: envelopeRecipients(mail),
      data,
    });
    if (!sent.ok) return { ok: false, error: { kind: 'smtp', reason: sent.reason } };
  } finally {
    await close();
  }
  return {
    ok: true,
    value: {
      sentCopy: isInbound(record) && imap !== null ? await storeSentCopy(imap, data) : 'send-only',
    },
  };
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
