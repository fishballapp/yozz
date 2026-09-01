import { buildMessage } from '@yozz.app/smtp';
import type { AddressRecord } from '../lib/addresses';
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
  readonly references?: readonly string[];
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

type Run = <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

/**
 * The private header every message this client sends carries: the draft it came from.
 *
 * It is how a send finds its OWN earlier copy when a step is retried. A Message-ID cannot do that
 * job — providers rewrite it — and a subject match is a guess.
 */

/**
 * The exact bytes a send is made of, built once and then stored on the draft record.
 *
 * Built once because a resend after a crash must be the SAME message, not a new one that happens
 * to say the same thing: rebuilding would mint a fresh Date and boundary, and the recipient would
 * see two messages instead of one delivered twice.
 */
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
 * The Sent copy, in a form a retry can run twice: it searches the mailbox for its own Message-ID
 * first, and appends only when the copy is not already there.
 *
 * Without that search a crash between the APPEND and the record that remembers it would leave the
 * person with two copies of everything they sent through a flaky connection.
 *
 * Message-ID and NOT the `X-Yozz-Draft` header this used to search: a server only has to index the
 * headers IMAP names, and Forward Email indexes none of ours, so the search answered empty for
 * every message and the guarantee above was never in force there.
 */
export const storeSentCopy = async (
  run: Run,
  bytes: Uint8Array,
  messageId: string,
): Promise<Result<{ uidValidity: number; uid: number } | null, SentCopyFailure>> => {
  let missingSent = false;
  const result = await run({
    priority: 'user',
    // The search makes a second run safe, so a retry here cannot duplicate the copy.
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
