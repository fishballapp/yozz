import type { ImapAddress, ImapMessageSummary } from '@yozz.app/imap';
import { FOLDERS, type Folder, type Message, threadIdOf } from '../lib/thread';
import { groupIntoThreads } from '../lib/threading';
import type { ThreadState } from '../state/mail';

/** What a sync hands the threader: each folder's summaries, by folder. */
export type FolderSummaries = Partial<Record<Folder, readonly ImapMessageSummary[]>>;

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parses the IMAP INTERNALDATE format (e.g. `23-Aug-2026 09:00:00 +0000`).
 *
 * `Date.parse` does not accept this format reliably across JavaScript engines.
 */
export const parseInternalDate = (dateStr: string | null | undefined): number | null => {
  if (dateStr === null || dateStr === undefined) return null;
  const trimmed = dateStr.trim();
  const match = trimmed.match(
    /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})$/,
  );
  if (!match) return null;

  const [_, dayStr, monStr, yearStr, hourStr, minStr, secStr, sign, tzHourStr, tzMinStr] = match;
  if (
    dayStr === undefined ||
    monStr === undefined ||
    yearStr === undefined ||
    hourStr === undefined ||
    minStr === undefined ||
    secStr === undefined ||
    sign === undefined ||
    tzHourStr === undefined ||
    tzMinStr === undefined
  ) {
    return null;
  }

  const month = MONTHS[monStr.toLowerCase()];
  if (month === undefined) return null;

  const day = Number.parseInt(dayStr, 10);
  const year = Number.parseInt(yearStr, 10);
  const hour = Number.parseInt(hourStr, 10);
  const min = Number.parseInt(minStr, 10);
  const sec = Number.parseInt(secStr, 10);

  const tzHours = Number.parseInt(tzHourStr, 10);
  const tzMins = Number.parseInt(tzMinStr, 10);
  const tzOffsetMinutes = (tzHours * 60 + tzMins) * (sign === '-' ? -1 : 1);

  const utcMillis = Date.UTC(year, month, day, hour, min, sec);
  const epochMillis = utcMillis - tzOffsetMinutes * 60 * 1000;
  return Number.isNaN(epochMillis) ? null : epochMillis;
};

const parseDate = (summary: ImapMessageSummary): number => {
  const internal = parseInternalDate(summary.internalDate);
  if (internal !== null) return internal;
  if (summary.envelope?.date) {
    const parsed = Date.parse(summary.envelope.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
};

const upper = (flags: readonly string[]) => flags.map(f => f.toUpperCase());

const addressOf = (address: ImapAddress | undefined) =>
  address?.mailbox && address?.host ? `${address.mailbox}@${address.host}` : null;

/** The envelope's `To` + `Cc` as addresses: lowercased so a comparison is case-blind, distinct, in header order. */
const recipientsOf = (envelope: ImapMessageSummary['envelope']): readonly string[] => [
  ...new Set(
    [...(envelope?.to ?? []), ...(envelope?.cc ?? [])].flatMap(
      address => addressOf(address)?.toLowerCase() ?? [],
    ),
  ),
];

const messageFromSummary = (
  summary: ImapMessageSummary,
  accountAddress: string,
  folder: Folder,
): Message => {
  const firstFrom = summary.envelope?.from?.[0];
  const fromMailboxHost = addressOf(firstFrom);
  const fromName = firstFrom?.name?.trim() || fromMailboxHost || accountAddress;
  const outbound =
    folder === 'sent' || fromMailboxHost?.toLowerCase() === accountAddress.toLowerCase();
  return {
    // A message id is `address/folder/uid`, the same shape as a thread id (`threadIdOf`).
    id: threadIdOf(accountAddress, folder, summary.uid),
    fromName,
    fromAddress: fromMailboxHost ?? '',
    // Your own copy went to whoever the envelope names — in Sent, or wherever a delete or restore
    // moved it; everything else arrived here whatever its To says (aliases, Bcc, lists).
    toAddress: outbound ? (addressOf(summary.envelope?.to?.[0]) ?? '') : accountAddress,
    recipients: recipientsOf(summary.envelope),
    at: parseDate(summary),
    body: [],
    bodyStatus: 'pending',
    ...(summary.size !== null ? { rawSize: summary.size } : {}),
    ...(summary.envelope?.messageId ? { messageId: summary.envelope.messageId } : {}),
  };
};

const subjectOf = (summary: ImapMessageSummary | undefined): string => {
  const raw = summary?.envelope?.subject?.trim();
  return raw !== undefined && raw !== '' ? raw : '(no subject)';
};

/**
 * Every synced summary of one account, grouped into conversations (`lib/threading.ts`). A
 * thread is named by its root message — the inbox's lowest uid, else Sent, else archive — its
 * messages run oldest first, its subject is the root's, and its flags are the union of its
 * messages' — a thread is unread while any message in it is. Its `folders` are the distinct
 * mailboxes its messages sit in, in `FOLDERS` order; `isArchived` and `isTrashed` read them.
 * Newest conversation first.
 */
export const threadsFromSummaries = (
  byFolder: FolderSummaries,
  accountAddress: string,
): ThreadState[] => {
  const byId = new Map(
    FOLDERS.flatMap(folder =>
      (byFolder[folder] ?? [])
        .toSorted((a, b) => a.uid - b.uid)
        .map(summary => [threadIdOf(accountAddress, folder, summary.uid), { folder, summary }]),
    ),
  );
  const groups = groupIntoThreads(
    [...byId].map(([id, { summary }]) => ({
      id,
      messageId: summary.envelope?.messageId ?? null,
      inReplyTo: summary.envelope?.inReplyTo ?? null,
      references: summary.references,
      subject: summary.envelope?.subject ?? null,
      gmailThreadId: summary.gmailThreadId,
    })),
  );
  const threads: ThreadState[] = [];
  for (const [rootId, ids] of groups) {
    const members = ids.flatMap(id => byId.get(id) ?? []);
    const messages = members
      .map(({ summary, folder }) => messageFromSummary(summary, accountAddress, folder))
      .sort((a, b) => a.at - b.at);
    const flags = members.map(({ summary }) => upper(summary.flags));
    const folders = FOLDERS.filter(folder => members.some(member => member.folder === folder));
    threads.push({
      id: rootId,
      accountId: accountAddress,
      subject: subjectOf(byId.get(rootId)?.summary),
      messages,
      isUnread: flags.some(f => !f.includes('\\SEEN')),
      isReplied: flags.some(f => f.includes('\\ANSWERED')),
      isStarred: flags.some(f => f.includes('\\FLAGGED')),
      folders,
    });
  }
  return threads.sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
};
