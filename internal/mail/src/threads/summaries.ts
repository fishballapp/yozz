import type { ImapAddress, ImapMessageSummary } from '@yozz.app/imap';
import { addressList } from '../compose/draft.ts';
import type { DraftRecord, FileReference } from '../compose/draft-record.ts';
import {
  draftIdOf,
  FOLDERS,
  type Folder,
  type Location,
  type Message,
  messageIdOf,
  physicalIdOf,
  type Recipient,
  type ThreadState,
  toParagraphs,
  VAULT_UID_VALIDITY,
} from './thread.ts';
import { baseSubject, groupIntoThreads } from './threading.ts';

/** A folder's summaries with the UIDVALIDITY they were read under; uids mean nothing without it. */
export type FolderRead = {
  readonly uidValidity: number;
  readonly summaries: readonly ImapMessageSummary[];
};

export type FolderSummaries = Partial<Record<Folder, FolderRead>>;

/** The folders whose messages are mail. Drafts are synced but are not mail. */
const MAIL_FOLDERS = FOLDERS.filter(folder => folder !== 'drafts');

/** Sent mail the vault holds because no mailbox does, or this tab's copy until a mailbox's syncs. */
export type VaultSentMessage = {
  readonly messageId: string;
  readonly at: number;
  readonly date: string;
  readonly from: string;
  readonly to: string;
  readonly cc: string;
  /** Who it was blind-copied to, when a record kept it. */
  readonly bcc?: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** In R2. Only the vault's own copy names any: a mailbox's holds its files itself. */
  readonly attachments?: readonly FileReference[];
};

/** A record's files on a message: opened from R2, since their bytes are not here. */
const attachmentsInR2 = (files: readonly FileReference[] | undefined) =>
  files === undefined || files.length === 0
    ? {}
    : { attachments: files.map(({ id, ...file }) => ({ ...file, fileId: id })) };

/**
 * A Message-ID an id may carry: printable ASCII in angle brackets, of a sane length. An id is shown
 * outside the mail-content framing of every client, so anything else uses the location form.
 */
const isPrintableMessageId = (messageId: string) =>
  /^<[\x21-\x3d\x3f-\x7e]{1,250}>$/u.test(messageId);

/** Every mailbox's folders, keyed by address: what one grouping pass reads. */
export type MailboxSummaries = Readonly<Record<string, FolderSummaries>>;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const INTERNAL_DATE =
  /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{2})(\d{2})$/;

/** IMAP INTERNALDATE (`23-Aug-2026 09:00:00 +0000`) as epoch milliseconds; null for a day or time that does not exist. */
export const parseInternalDate = (dateStr: string | null | undefined): number | null => {
  const match = INTERNAL_DATE.exec(dateStr?.trim() ?? '');
  if (match === null) return null;
  const [
    ,
    day = '',
    monthName = '',
    year = '',
    hour = '',
    minute = '',
    second = '',
    zoneHours = '',
    zoneMinutes = '',
  ] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
  if (month === 0) return null;
  try {
    return Temporal.ZonedDateTime.from(
      {
        timeZone: `${zoneHours}:${zoneMinutes}`,
        year: Number(year),
        month,
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
      },
      { overflow: 'reject' },
    ).epochMilliseconds;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
};

const parseDate = (summary: ImapMessageSummary): number => {
  const internal = parseInternalDate(summary.internalDate);
  if (internal !== null) return internal;
  if (summary.envelope?.date) {
    // RFC 5322 dates arrive in every obsolete form (named zones, comments, two-digit years), which
    // only `Date.parse` reads; Temporal parses ISO 8601 alone.
    const parsed = Date.parse(summary.envelope.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
};

const upper = (flags: readonly string[]) => flags.map(f => f.toUpperCase());

const addressOf = (address: ImapAddress | undefined) =>
  address?.mailbox && address?.host ? `${address.mailbox}@${address.host}` : null;

/**
 * A group-syntax marker has no mailbox or host, so it is not a recipient. A name that only repeats
 * the address (Outlook's `"bob@x.com" <bob@x.com>`) is no name.
 */
const recipientsIn = (addresses: readonly ImapAddress[] | undefined): readonly Recipient[] =>
  (addresses ?? []).flatMap(address => {
    const at = addressOf(address);
    const name = address.name?.trim();
    const isName = name !== undefined && name !== '' && name.toLowerCase() !== at?.toLowerCase();
    return at === null ? [] : [{ address: at, ...(isName ? { name } : {}) }];
  });

/**
 * `toAddress` is read from a copy that arrived (any folder but Sent); a message with only Sent
 * copies is one you wrote. With copies in two mailboxes the earliest arriving one wins.
 */
const messageFromCopies = (
  id: string,
  summary: ImapMessageSummary,
  locations: readonly Location[],
): Message => {
  const firstFrom = summary.envelope?.from?.[0];
  const fromMailboxHost = addressOf(firstFrom);
  const arrived = locations.find(location => location.folder !== 'sent');
  const owner = arrived?.mailbox ?? locations[0]?.mailbox ?? '';
  const fromName = firstFrom?.name?.trim() || fromMailboxHost || owner;
  const outbound = arrived === undefined || fromMailboxHost?.toLowerCase() === owner.toLowerCase();
  // The server fills an absent Reply-To with From (RFC 9051 §7.5.2), so only another address is news.
  const replyTo = recipientsIn(summary.envelope?.replyTo);
  const repliesElsewhere = replyTo.some(
    ({ address }) => address.toLowerCase() !== fromMailboxHost?.toLowerCase(),
  );
  const bcc = recipientsIn(summary.envelope?.bcc);
  return {
    id,
    locations,
    fromName,
    fromAddress: fromMailboxHost ?? '',
    // Your own copy went to whoever the envelope names; everything else arrived here whatever its To says.
    toAddress: outbound ? (addressOf(summary.envelope?.to?.[0]) ?? '') : owner,
    to: recipientsIn(summary.envelope?.to),
    cc: recipientsIn(summary.envelope?.cc),
    ...(repliesElsewhere ? { replyTo } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(summary.attachmentNames.length > 0 ? { attachmentNames: summary.attachmentNames } : {}),
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

/** By the composer's own rule, which is the one the send used: commas, semicolons and spaces. */
const asImapAddresses = (list: string): readonly ImapAddress[] =>
  addressList(list).flatMap(part => asImapAddress(part) ?? []);

/**
 * `VAULT_UID_VALIDITY` marks a location no server issued. When the same message later turns up in a
 * real Sent folder the fingerprint collapses the two and the real copy leads.
 */
const asSyntheticCopy = (message: VaultSentMessage) => ({
  location: {
    mailbox: message.from,
    folder: 'sent' as const,
    uidValidity: VAULT_UID_VALIDITY,
    uid: 0,
  },
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
      bcc: asImapAddresses(message.bcc ?? ''),
      inReplyTo: message.inReplyTo ?? null,
      messageId: message.messageId,
    },
    references: message.references ?? [],
    gmailThreadId: null,
    attachmentNames: [],
  } satisfies ImapMessageSummary,
  mailbox: message.from,
  folder: 'sent' as const,
});

/**
 * Copies collapse into one displayed message on equal Message-ID, From, envelope Date and base
 * subject (not INTERNALDATE, which differs between the Inbox and Sent copies). Flags are the union
 * across copies. See DECISIONS.md, "Threads span accounts, and an id stops naming one".
 */
export const threadsFromMailboxes = (
  byMailbox: MailboxSummaries,
  vaultSent: readonly VaultSentMessage[] = [],
): ThreadState[] => {
  const copies = [
    ...vaultSent.map(asSyntheticCopy),
    ...Object.entries(byMailbox).flatMap(([mailbox, byFolder]) =>
      // Drafts are synced for the mirror but are not mail: threaded in, a server-side draft would be
      // counted unread and eligible for flag writes and body loads.
      MAIL_FOLDERS.flatMap(folder => {
        const read = byFolder[folder];
        return read === undefined
          ? []
          : read.summaries.map(summary => ({
              location: { mailbox, folder, uidValidity: read.uidValidity, uid: summary.uid },
              summary,
              mailbox,
              folder,
            }));
      }),
    ),
  ];

  /**
   * A copy with no Message-ID is its own message. A copy in Junk joins only other Junk copies: spam
   * that shares a real message's Message-ID must not take its place.
   */
  const fingerprint = ({ summary, folder }: (typeof copies)[number]) => {
    const messageId = summary.envelope?.messageId;
    if (!messageId) return null;
    return [
      folder === 'junk' ? 'junk' : 'mail',
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
      if (ia < ib) return -1;
      if (ia > ib) return 1;
      return 0;
    });

  // Flags are per copy: a message read in one mailbox is still unread in the other.
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

  // `mid/` is only a name when it names one message. Mail is counted apart from Junk, so whether spam
  // carrying a real Message-ID is loaded never renames that message; a Junk message takes `mid/` only
  // where no mail does, so one moved wholly into or out of Junk keeps its id.
  const isJunkEntry = (entry: Merged) => entry.folder === 'junk';
  const countsOf = (entries: readonly Merged[]) => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      const messageId = entry.summary.envelope?.messageId;
      if (messageId) counts.set(messageId, (counts.get(messageId) ?? 0) + 1);
    }
    return counts;
  };
  const mailCounts = countsOf(merged.filter(entry => !isJunkEntry(entry)));
  const junkCounts = countsOf(merged.filter(isJunkEntry));
  const idOf = (entry: Merged) => {
    const messageId = entry.summary.envelope?.messageId;
    const isOnlyOne = (() => {
      if (!messageId) return false;
      if (!isJunkEntry(entry)) return mailCounts.get(messageId) === 1;
      return !mailCounts.has(messageId) && junkCounts.get(messageId) === 1;
    })();
    return messageId && isOnlyOne && isPrintableMessageId(messageId)
      ? messageIdOf(messageId)
      : physicalIdOf(entry.locations[0] ?? entry.location);
  };

  const byId = new Map(merged.map(entry => [idOf(entry), entry] as const));
  // Junk is each message on its own: a spam "Re: invoice" must not join a real conversation by its
  // subject or its References. Its copies were kept apart above, so an entry is Junk's whole.
  const { junk = [], mail = [] } = Object.groupBy([...byId], ([, entry]) =>
    isJunkEntry(entry) ? 'junk' : 'mail',
  );
  const groups = [
    ...groupIntoThreads(
      mail.map(([id, entry]) => ({
        id,
        messageId: entry.summary.envelope?.messageId ?? null,
        inReplyTo: entry.summary.envelope?.inReplyTo ?? null,
        references: entry.summary.references,
        subject: entry.summary.envelope?.subject ?? null,
        gmailThreadId: entry.summary.gmailThreadId,
        gmailMailbox: entry.mailbox,
      })),
    ),
    ...junk.map(([id]) => [id, [id]] as const),
  ];

  const vaultHeld = new Map(vaultSent.map(message => [message.messageId, message]));
  const threads: ThreadState[] = [];
  for (const [rootId, ids] of groups) {
    const members = ids.flatMap(id => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{ id, entry }];
    });
    const messages = members
      .map(({ id, entry }) => {
        const message = {
          ...messageFromCopies(id, entry.summary, entry.locations),
          ...(entry.flags.some(copy => !copy.includes('\\SEEN')) ? { isUnread: true } : {}),
          ...(entry.flags.some(copy => copy.includes('\\FLAGGED')) ? { isStarred: true } : {}),
        };
        // A vault-held message carries its own text; `pending` would spin for ever.
        const held = vaultHeld.get(entry.summary.envelope?.messageId ?? '');
        return held === undefined
          ? message
          : {
              ...message,
              body: toParagraphs(held.body),
              hasTextPart: true,
              bodyStatus: undefined,
              ...attachmentsInR2(held.attachments),
            };
      })
      .sort((a, b) => a.at - b.at);
    const flags = members.flatMap(({ entry }) => entry.flags);
    const locations = members.flatMap(({ entry }) => entry.locations);
    const folders = FOLDERS.filter(folder =>
      locations.some(location => location.folder === folder),
    );
    const mailboxes = [...new Set(locations.map(location => location.mailbox))].toSorted();
    const foldersByMailbox = Object.fromEntries(
      mailboxes.map(mailbox => [
        mailbox,
        FOLDERS.filter(folder =>
          locations.some(location => location.mailbox === mailbox && location.folder === folder),
        ),
      ]),
    );
    threads.push({
      id: rootId,
      mailboxes,
      subject: subjectOf(byId.get(rootId)?.summary),
      messages,
      isUnread: flags.some(f => !f.includes('\\SEEN')),
      isReplied: flags.some(f => f.includes('\\ANSWERED')),
      isStarred: flags.some(f => f.includes('\\FLAGGED')),
      folders,
      foldersByMailbox,
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
      ...attachmentsInR2(record.attachments),
    };
    // Named by the record, else found by the message its `In-Reply-To` points at.
    const parent =
      (record.threadId === undefined ? undefined : byId.get(record.threadId)) ??
      // ponytail: a Junk message forging the Message-ID a draft replies to can take that draft into
      // Junk with it; rare, and the draft is still listed in Drafts. Un-park when seen.
      (record.inReplyTo === undefined
        ? undefined
        : threads.find(thread =>
            thread.messages.some(candidate => candidate.messageId === record.inReplyTo),
          ));
    if (parent === undefined) {
      extra.push({
        id: draftIdOf(draftKey),
        mailboxes: [],
        subject: record.subject === '' ? '(no subject)' : record.subject,
        messages: [message],
        isUnread: false,
        isReplied: false,
        isStarred: false,
        folders: ['drafts'],
        foldersByMailbox: {},
      });
      continue;
    }
    // A conversation carrying your draft is listed, even one only a search found.
    const { isFoundOnly: _, ...carrying } = own.get(parent.id) ?? parent;
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
