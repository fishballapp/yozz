import type { ImapAddress, ImapMessageSummary } from '@yozz.app/imap';
import type { DraftRecord } from '../lib/drafts';
import {
  draftIdOf,
  FOLDERS,
  type Folder,
  type Location,
  type Message,
  messageIdOf,
  physicalIdOf,
} from '../lib/thread';
import { baseSubject, groupIntoThreads } from '../lib/threading';
import type { ThreadState } from '../state/mail';
import { toParagraphs } from './bodies';

/** Each folder's summaries with the UIDVALIDITY they were read under; uids mean nothing without it. */
export type FolderSummaries = Partial<
  Record<
    Folder,
    { readonly uidValidity: number; readonly summaries: readonly ImapMessageSummary[] }
  >
>;

/** The folders whose messages are threaded as mail. Drafts are synced but are not mail. */
const THREADED_FOLDERS = FOLDERS.filter(folder => folder !== 'drafts');

/** Sent mail the vault holds because no mailbox does. Structurally a `SentRecord` without bytes. */
export type VaultSentMessage = {
  readonly messageId: string;
  readonly at: number;
  readonly date: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
};

/** Every account's folders, keyed by address: what one grouping pass reads. */
export type AccountSummaries = Readonly<Record<string, FolderSummaries>>;

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

/** IMAP INTERNALDATE (`23-Aug-2026 09:00:00 +0000`); `Date.parse` does not accept it reliably across engines. */
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

/** The envelope's `To` + `Cc`, lowercased, distinct, in header order. */
const recipientsOf = (envelope: ImapMessageSummary['envelope']): readonly string[] => [
  ...new Set(
    [...(envelope?.to ?? []), ...(envelope?.cc ?? [])].flatMap(
      address => addressOf(address)?.toLowerCase() ?? [],
    ),
  ),
];

/**
 * `toAddress` is read from a copy that arrived (any folder but Sent); a message with only Sent
 * copies is one you wrote. With copies in two accounts the earliest arriving one wins.
 */
const messageFromCopies = (
  id: string,
  summary: ImapMessageSummary,
  locations: readonly Location[],
): Message => {
  const firstFrom = summary.envelope?.from?.[0];
  const fromMailboxHost = addressOf(firstFrom);
  const arrived = locations.find(location => location.folder !== 'sent');
  const owner = arrived?.account ?? locations[0]?.account ?? '';
  const fromName = firstFrom?.name?.trim() || fromMailboxHost || owner;
  const outbound = arrived === undefined || fromMailboxHost?.toLowerCase() === owner.toLowerCase();
  return {
    id,
    locations,
    fromName,
    fromAddress: fromMailboxHost ?? '',
    // Your own copy went to whoever the envelope names; everything else arrived here whatever its To says.
    toAddress: outbound ? (addressOf(summary.envelope?.to?.[0]) ?? '') : owner,
    recipients: recipientsOf(summary.envelope),
    at: parseDate(summary),
    body: [],
    bodyStatus: 'pending',
    ...(summary.size !== null ? { rawSize: summary.size } : {}),
    ...(summary.envelope?.messageId ? { messageId: summary.envelope.messageId } : {}),
    ...(summary.references.length > 0 ? { references: summary.references } : {}),
  };
};

const subjectOf = (summary: ImapMessageSummary | undefined): string => {
  const raw = summary?.envelope?.subject?.trim();
  return raw !== undefined && raw !== '' ? raw : '(no subject)';
};

/** `name@host` as an envelope address. */
const asImapAddress = (address: string): ImapAddress | null => {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: null, mailbox: address.slice(0, at).trim(), host: address.slice(at + 1).trim() };
};

const asImapAddresses = (list: string): readonly ImapAddress[] =>
  list.split(',').flatMap(part => asImapAddress(part.trim()) ?? []);

/**
 * `uidValidity: 0` marks a location no server issued. When the same message later turns up in a
 * real Sent folder the fingerprint collapses the two and the real copy leads.
 */
const asSyntheticCopy = (message: VaultSentMessage) => ({
  location: { account: message.from, folder: 'sent' as const, uidValidity: 0, uid: 0 },
  summary: {
    seq: 0,
    uid: 0,
    flags: ['\\Seen'],
    internalDate: null,
    size: null,
    envelope: {
      date: message.date,
      subject: message.subject,
      subjectRaw: message.subject,
      from: asImapAddresses(message.from),
      sender: asImapAddresses(message.from),
      replyTo: asImapAddresses(message.from),
      to: asImapAddresses(message.to),
      cc: asImapAddresses(message.cc),
      bcc: [],
      inReplyTo: message.inReplyTo ?? null,
      messageId: message.messageId,
    },
    references: message.references ?? [],
    gmailThreadId: null,
  } satisfies ImapMessageSummary,
  account: message.from,
  folder: 'sent' as const,
});

/**
 * Every account's summaries grouped into conversations (`lib/threading.ts`) in one pass. Copies
 * collapse into one displayed message on equal Message-ID, From, envelope Date and base subject
 * (not INTERNALDATE, which differs between the Inbox and Sent copies). Flags are the union across
 * copies. See DECISIONS.md, "Threads span accounts, and an id stops naming one".
 */
export const threadsFromAccounts = (
  byAccount: AccountSummaries,
  vaultSent: readonly VaultSentMessage[] = [],
): ThreadState[] => {
  const copies = [
    ...vaultSent.map(asSyntheticCopy),
    ...Object.entries(byAccount).flatMap(([account, byFolder]) =>
      // Drafts are synced for the mirror but are not mail: threaded in, a server-side draft would be
      // counted unread and eligible for flag writes and body loads.
      THREADED_FOLDERS.flatMap(folder => {
        const read = byFolder[folder];
        return read === undefined
          ? []
          : read.summaries.map(summary => ({
              location: { account, folder, uidValidity: read.uidValidity, uid: summary.uid },
              summary,
              account,
              folder,
            }));
      }),
    ),
  ];

  /** A copy with no Message-ID is its own message. */
  const fingerprint = ({ summary }: (typeof copies)[number]) => {
    const messageId = summary.envelope?.messageId;
    if (!messageId) return null;
    return [
      messageId,
      addressOf(summary.envelope?.from?.[0]) ?? '',
      summary.envelope?.date ?? '',
      baseSubject(summary.envelope?.subject ?? null),
    ].join('\u0000');
  };

  /**
   * Oldest first, ties by FOLDERS order then physical id, so the leading copy never depends on sync
   * order and `locations[0]` is the liveliest copy.
   */
  const ordered = copies
    .map(copy => ({ ...copy, at: parseDate(copy.summary), print: fingerprint(copy) }))
    .toSorted((a, b) => {
      const byDate = a.at - b.at;
      if (byDate !== 0) return byDate;
      const byFolder = FOLDERS.indexOf(a.folder) - FOLDERS.indexOf(b.folder);
      if (byFolder !== 0) return byFolder;
      const [ia, ib] = [physicalIdOf(a.location), physicalIdOf(b.location)];
      return ia < ib ? -1 : ia > ib ? 1 : 0;
    });

  // Flags are per copy: a message read in one account is still unread in the other.
  type Merged = (typeof ordered)[number] & {
    readonly locations: Location[];
    readonly flags: string[][];
  };
  const merged: Merged[] = [];
  const byPrint = new Map<string, Merged>();
  for (const copy of ordered) {
    const existing = copy.print === null ? undefined : byPrint.get(copy.print);
    if (existing !== undefined) {
      existing.locations.push(copy.location);
      existing.flags.push(upper(copy.summary.flags));
      continue;
    }
    const entry: Merged = {
      ...copy,
      locations: [copy.location],
      flags: [upper(copy.summary.flags)],
    };
    merged.push(entry);
    if (copy.print !== null) byPrint.set(copy.print, entry);
  }

  // `mid/` is only a name when it names one message.
  const midCounts = new Map<string, number>();
  for (const entry of merged) {
    const messageId = entry.summary.envelope?.messageId;
    if (messageId) midCounts.set(messageId, (midCounts.get(messageId) ?? 0) + 1);
  }
  const idOf = (entry: Merged) => {
    const messageId = entry.summary.envelope?.messageId;
    return messageId && midCounts.get(messageId) === 1
      ? messageIdOf(messageId)
      : physicalIdOf(entry.locations[0] ?? entry.location);
  };

  const byId = new Map(merged.map(entry => [idOf(entry), entry] as const));
  const groups = groupIntoThreads(
    [...byId].map(([id, entry]) => ({
      id,
      messageId: entry.summary.envelope?.messageId ?? null,
      inReplyTo: entry.summary.envelope?.inReplyTo ?? null,
      references: entry.summary.references,
      subject: entry.summary.envelope?.subject ?? null,
      gmailThreadId: entry.summary.gmailThreadId,
      gmailAccount: entry.account,
    })),
  );

  const vaultBodies = new Map(vaultSent.map(message => [message.messageId, message.body]));
  const threads: ThreadState[] = [];
  for (const [rootId, ids] of groups) {
    const members = ids.flatMap(id => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{ id, entry }];
    });
    const messages = members
      .map(({ id, entry }) => {
        const message = messageFromCopies(id, entry.summary, entry.locations);
        // A vault-held message carries its own text; `pending` would spin for ever.
        const held = vaultBodies.get(entry.summary.envelope?.messageId ?? '');
        return held === undefined
          ? message
          : { ...message, body: toParagraphs(held), hasTextPart: true, bodyStatus: undefined };
      })
      .sort((a, b) => a.at - b.at);
    const flags = members.flatMap(({ entry }) => entry.flags);
    const locations = members.flatMap(({ entry }) => entry.locations);
    const folders = FOLDERS.filter(folder =>
      locations.some(location => location.folder === folder),
    );
    const accounts = [...new Set(locations.map(location => location.account))].toSorted();
    const foldersByAccount = Object.fromEntries(
      accounts.map(account => [
        account,
        FOLDERS.filter(folder =>
          locations.some(location => location.account === account && location.folder === folder),
        ),
      ]),
    );
    threads.push({
      id: rootId,
      accounts,
      subject: subjectOf(byId.get(rootId)?.summary),
      messages,
      isUnread: flags.some(f => !f.includes('\\SEEN')),
      isReplied: flags.some(f => f.includes('\\ANSWERED')),
      isStarred: flags.some(f => f.includes('\\FLAGGED')),
      folders,
      foldersByAccount,
    });
  }
  return threads.sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
};

/** Folded in after the grouping pass: a draft has no Message-ID, no server copy and no flags. Its id is `draft/<draftKey>`. */
export const withDrafts = (
  threads: readonly ThreadState[],
  drafts: readonly {
    readonly draftKey: string;
    readonly draftId: string;
    readonly record: DraftRecord;
  }[],
): readonly ThreadState[] => {
  if (drafts.length === 0) return threads;
  const byId = new Map(threads.map(thread => [thread.id, thread]));
  const own = new Map<string, ThreadState>();
  const extra: ThreadState[] = [];

  for (const { draftKey, draftId, record } of drafts) {
    const message: Message = {
      id: draftIdOf(draftKey),
      fromName: record.from,
      fromAddress: record.from,
      toAddress: record.to,
      at: record.updatedAt ?? 0,
      body: toParagraphs(record.body),
      locations: [],
      isDraft: true,
      draftKey,
      draftId,
    };
    // Named by the record, else found by the message its `In-Reply-To` points at.
    const parent =
      (record.threadId === undefined ? undefined : byId.get(record.threadId)) ??
      (record.inReplyTo === undefined
        ? undefined
        : threads.find(thread =>
            thread.messages.some(candidate => candidate.messageId === record.inReplyTo),
          ));
    if (parent === undefined) {
      extra.push({
        id: draftIdOf(draftKey),
        accounts: [],
        subject: record.subject === '' ? '(no subject)' : record.subject,
        messages: [message],
        isUnread: false,
        isReplied: false,
        isStarred: false,
        folders: ['drafts'],
        foldersByAccount: {},
      });
      continue;
    }
    const carrying = own.get(parent.id) ?? parent;
    own.set(parent.id, {
      ...carrying,
      messages: [...carrying.messages, message],
      // Now in Drafts as well as wherever its mail is.
      folders: carrying.folders.includes('drafts')
        ? carrying.folders
        : [...carrying.folders, 'drafts'],
    });
  }
  return [...threads.map(thread => own.get(thread.id) ?? thread), ...extra].toSorted(
    (a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0),
  );
};
