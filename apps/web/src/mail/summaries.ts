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

/**
 * What a sync hands the threader: each folder's summaries, and the UIDVALIDITY they were read
 * under. The uids in a folder are only meaningful together with it, so they travel together.
 */
export type FolderSummaries = Partial<
  Record<
    Folder,
    { readonly uidValidity: number; readonly summaries: readonly ImapMessageSummary[] }
  >
>;

/** The folders whose messages are threaded as mail. Drafts are synced but are not mail. */
const THREADED_FOLDERS = FOLDERS.filter(folder => folder !== 'drafts');

/**
 * Sent mail the vault holds because no mailbox does: what a send-only address leaves behind.
 *
 * It joins the same grouping pass as everything else, so a reply you sent from an alias sits in
 * its conversation rather than in a list of its own. Structurally a `SentRecord` without bytes.
 */
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

/** Every account's folders, which is what one grouping pass reads. Keyed by address. */
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

/**
 * One displayed message from every copy of it. `toAddress` answers "which of my addresses did
 * this reach", so it is read from a copy that ARRIVED — the account holding it in any folder but
 * Sent — and a message with only Sent copies is one you wrote, whose recipient the envelope
 * names. With copies in two accounts the earliest arriving one wins, which is the same
 * oldest-first order everything else here uses.
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
    // Your own copy went to whoever the envelope names — in Sent, or wherever a delete or restore
    // moved it; everything else arrived here whatever its To says (aliases, Bcc, lists).
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

/** `name@host` as an envelope address, which is all the threader reads them for. */
const asImapAddress = (address: string): ImapAddress | null => {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  return { name: null, mailbox: address.slice(0, at).trim(), host: address.slice(at + 1).trim() };
};

const asImapAddresses = (list: string): readonly ImapAddress[] =>
  list.split(',').flatMap(part => asImapAddress(part.trim()) ?? []);

/**
 * A vault-held sent message, dressed as the summary the rest of this file reads.
 *
 * `uidValidity: 0` marks the location as one no server issued — nothing syncs, moves or flags it,
 * because no account owns it. When the same message later turns up in a real Sent folder (the
 * address gained a mailbox, or the provider kept its own copy), the fingerprint collapses the two
 * into one row and the real copy leads, which is what "adoption" amounts to.
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
 * Every synced summary of EVERY account, grouped into conversations (`lib/threading.ts`).
 *
 * One pass over all accounts, not one per account, because a conversation is not the property of
 * a mailbox: two of your addresses copied on the same mail hold the same conversation, and
 * running the grouping per account leaves each with half of it and the other half orphaned.
 *
 * **Physical copies collapse into one displayed message** when they are the same RFC message:
 * equal Message-ID AND equal From, envelope Date and base subject. The fingerprint is what keeps
 * a Message-ID collision (two different messages, one id — rare but real, and cheap for a
 * hostile sender to arrange) from merging strangers into one row. INTERNALDATE is deliberately
 * NOT in it: the Inbox copy and the Sent copy of one message have different ones.
 *
 * A message is named by `mid/<Message-ID>` when that id names exactly one displayed message, else
 * by one physical copy; a thread by its EARLIEST message, so an id keeps naming the same mail
 * through every move, and only an older message backfilled by paging can change a thread's root.
 * Its messages run oldest first, its subject is the root's, and its flags are the union across
 * every copy — a thread is unread while any copy anywhere is. `folders` are the distinct
 * mailboxes it occupies across all accounts; `foldersByAccount` is the same per account, which is
 * what one address's view filters on. Newest conversation first.
 */
export const threadsFromAccounts = (
  byAccount: AccountSummaries,
  vaultSent: readonly VaultSentMessage[] = [],
): ThreadState[] => {
  const copies = [
    ...vaultSent.map(asSyntheticCopy),
    ...Object.entries(byAccount).flatMap(([account, byFolder]) =>
      // Drafts are synced so the mirror can be built on them, but they are NOT mail: threading a
      // server-side draft in would make it an ordinary message in its conversation — counted in the
      // unread rollup, reachable from Starred or Archive through its siblings, and eligible for
      // flag writes and body loads. Until the mirror and the foreign-draft badge land, they stay out.
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

  /**
   * What makes two copies the same message. A copy with no Message-ID is its own message: there
   * is nothing to claim it is the same as anything else.
   */
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
   * Oldest copy first, and ties broken by FOLDERS order then by the physical id. Deterministic,
   * so which copy leads a displayed message never depends on the order accounts happened to sync
   * in; and folder-ranked, so the copy that leads is the liveliest one — `locations[0]` is what a
   * body fetch reads and what names a message with no usable Message-ID, and reading either out
   * of the bin while the inbox still holds it would be a strange answer.
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

  /**
   * `summary` is the leading copy's, which is what names and dates the message — they are the
   * same message, so any copy answers. FLAGS are not like that: they are per copy, and a message
   * read in one account is still unread in the other. So every copy's flags are kept and the
   * rollups union them, or a thread unread in one account would show as read because the copy
   * that happened to lead was seen.
   */
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

  // `mid/` is only a name when it names ONE message. Two fingerprint-distinct messages sharing a
  // Message-ID both fall back, rather than one of them silently answering for the other.
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
        // A vault-held message carries its own text: there is no server to fetch it from, and
        // leaving it `pending` would spin for ever on a body that is already here.
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

/**
 * A vault draft as its conversation shows it: a message in the thread it replies to, or a thread
 * of its own when it replies to nothing.
 *
 * Folded in AFTER the grouping pass rather than through it, because a draft is not mail — it has
 * no Message-ID until it is sent, no copy on any server this client owns, and no flags. Its id is
 * `draft/<draftKey>`, which survives every edit and every changing mirror id.
 */
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
    // The conversation it is a reply to: named outright by the record, else found by the message
    // its `In-Reply-To` points at.
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
      // The thread is now in Drafts as well as wherever its mail is, which is what lists it there.
      folders: carrying.folders.includes('drafts')
        ? carrying.folders
        : [...carrying.folders, 'drafts'],
    });
  }
  return [...threads.map(thread => own.get(thread.id) ?? thread), ...extra].toSorted(
    (a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0),
  );
};
