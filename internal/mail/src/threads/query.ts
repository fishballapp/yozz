import type { Result } from '../connection.ts';
import { FOLDERS, type Folder, isServerCopy, type Message, type ThreadState } from './thread.ts';

/** What one bare word, phrase or operator looks in. */
export type TermField = 'any' | 'from' | 'to' | 'subject';

export type SearchTerm = { readonly field: TermField; readonly text: string };

/** A calendar day; `month` runs 1 to 12. */
export type CalendarDay = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

type InValue = Folder | 'anywhere';

export type SearchQuery = {
  /** All must match within one message. */
  readonly terms: readonly SearchTerm[];
  /** Repeated, a union. */
  readonly in: readonly InValue[];
  /** Repeated, a union. */
  readonly mailboxes: readonly string[];
  readonly isUnread: boolean;
  readonly isStarred: boolean;
  /** Strictly before each of these days. */
  readonly before: readonly CalendarDay[];
  /** On or after each of these days. */
  readonly after: readonly CalendarDay[];
};

type Clause =
  | { readonly kind: 'term'; readonly term: SearchTerm }
  | { readonly kind: 'in'; readonly value: InValue }
  | { readonly kind: 'mailbox'; readonly address: string }
  | { readonly kind: 'unread' | 'starred' }
  | { readonly kind: 'before' | 'after'; readonly day: CalendarDay };

const dayIn = (text: string): CalendarDay | null => {
  const match = /^(\d{4})([/-])(\d{2})\2(\d{2})$/u.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[3]), Number(match[4])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // `Date` rolls an impossible day over to the next month, so it comes back different.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : null;
};

const IN_VALUES: readonly InValue[] = [...FOLDERS, 'anywhere'];

/** A clause per operator, null for a value it cannot take. Keys are lowercase. */
const OPERATORS: Readonly<Record<string, (value: string) => Clause | null>> = {
  from: text => ({ kind: 'term', term: { field: 'from', text } }),
  to: text => ({ kind: 'term', term: { field: 'to', text } }),
  subject: text => ({ kind: 'term', term: { field: 'subject', text } }),
  in: value => {
    const known = IN_VALUES.find(candidate => candidate === value.toLowerCase());
    return known === undefined ? null : { kind: 'in', value: known };
  },
  mailbox: address => (/^[^\s@]+@[^\s@]+$/u.test(address) ? { kind: 'mailbox', address } : null),
  is: value => {
    const flag = value.toLowerCase();
    return flag === 'unread' || flag === 'starred' ? { kind: flag } : null;
  },
  before: text => {
    const day = dayIn(text);
    return day === null ? null : { kind: 'before', day };
  },
  after: text => {
    const day = dayIn(text);
    return day === null ? null : { kind: 'after', day };
  },
};

const plainText = (text: string): Clause => ({ kind: 'term', term: { field: 'any', text } });

/** `key:value`, `key:"quoted value"`, `"a phrase"` (an unclosed quote runs to the end), or a word. */
const TOKEN = /([^\s":]+):"([^"]*)"?|"([^"]*)"?|(\S+)/gu;

const clauseOf = ([, quotedKey, quotedValue, phrase, word]: RegExpExecArray): Clause | null => {
  if (phrase !== undefined) return phrase.trim() === '' ? null : plainText(phrase);
  const colon = word?.indexOf(':') ?? -1;
  const key = quotedKey ?? word?.slice(0, Math.max(colon, 0)) ?? '';
  const value = quotedValue ?? word?.slice(colon + 1) ?? '';
  const operator = Object.hasOwn(OPERATORS, key.toLowerCase())
    ? OPERATORS[key.toLowerCase()]
    : undefined;
  const clause = value.trim() === '' ? null : (operator?.(value) ?? null);
  return clause ?? plainText(word ?? `${key}:${value}`);
};

/** The query language. Total: whatever is not an operator with a value it can take is plain text. */
export const parseQuery = (text: string): SearchQuery => {
  const clauses = [...text.matchAll(TOKEN)].flatMap(token => clauseOf(token) ?? []);
  return {
    terms: clauses.flatMap(clause => (clause.kind === 'term' ? [clause.term] : [])),
    in: clauses.flatMap(clause => (clause.kind === 'in' ? [clause.value] : [])),
    mailboxes: clauses.flatMap(clause => (clause.kind === 'mailbox' ? [clause.address] : [])),
    isUnread: clauses.some(({ kind }) => kind === 'unread'),
    isStarred: clauses.some(({ kind }) => kind === 'starred'),
    before: clauses.flatMap(clause => (clause.kind === 'before' ? [clause.day] : [])),
    after: clauses.flatMap(clause => (clause.kind === 'after' ? [clause.day] : [])),
  };
};

/** Something to look for, not only somewhere to look. */
export const hasCriteria = ({ terms, isUnread, isStarred, before, after }: SearchQuery) =>
  terms.length > 0 || isUnread || isStarred || before.length > 0 || after.length > 0;

export type SearchScope<T> = {
  readonly folders: readonly Folder[];
  /** Whose servers to ask: every one, or those `mailbox:` named. */
  readonly mailboxes: readonly T[];
  /** No `mailbox:` narrowed it, so what no login holds (a send-only address's) counts too. */
  readonly isEveryMailbox: boolean;
};

/**
 * Where a query looks. An empty one is the inbox of every mailbox; any other with no `in:` is every
 * folder but Trash, which only `in:trash` or `in:anywhere` reach. `mailbox:` names one login's
 * mailbox by the address it connects under; anything else is an error rather than an empty answer,
 * since an empty answer would read as having no such mail.
 */
export const resolveScope = <T extends { readonly address: string }>(
  query: SearchQuery,
  inbound: readonly T[],
): Result<SearchScope<T>, { readonly message: string }> => {
  const named = new Set(query.mailboxes.map(address => address.toLowerCase()));
  const unknown = query.mailboxes.find(
    address => !inbound.some(mailbox => mailbox.address.toLowerCase() === address.toLowerCase()),
  );
  if (unknown !== undefined) {
    return {
      ok: false,
      error: {
        message: `${unknown} has no mailbox: it is an alias, send-only or not yours, so nothing is held under it. To find mail sent to it, use to:${unknown}`,
      },
    };
  }
  const isEmpty = !hasCriteria(query) && query.in.length === 0 && named.size === 0;
  const wanted = (folder: Folder) => {
    if (isEmpty) return folder === 'inbox';
    if (query.in.length === 0) return folder !== 'trash';
    return query.in.includes(folder) || query.in.includes('anywhere');
  };
  return {
    ok: true,
    value: {
      folders: FOLDERS.filter(wanted),
      mailboxes:
        named.size === 0
          ? inbound
          : inbound.filter(({ address }) => named.has(address.toLowerCase())),
      isEveryMailbox: named.size === 0,
    },
  };
};

const VIEW_OF_FOLDER: Readonly<
  Record<Folder, 'unified' | 'sent' | 'archive' | 'trash' | 'drafts'>
> = {
  inbox: 'unified',
  sent: 'sent',
  archive: 'archive',
  trash: 'trash',
  drafts: 'drafts',
};

/** The view a row found in `folders` opens under: that folder's when there is just one. */
export const viewOfFolders = (folders: readonly Folder[]) => {
  const [only] = folders;
  return only !== undefined && folders.length === 1 ? VIEW_OF_FOLDER[only] : 'unified';
};

/** A copy of it, or the draft it is, sits where the scope looks. */
export const isMessageInScope =
  <T extends { readonly address: string }>({
    folders,
    mailboxes,
    isEveryMailbox,
  }: SearchScope<T>) =>
  (message: Message): boolean => {
    const isOurs = (address: string) =>
      isEveryMailbox ||
      mailboxes.some(mailbox => mailbox.address.toLowerCase() === address.toLowerCase());
    if (message.isDraft === true) return folders.includes('drafts') && isOurs(message.fromAddress);
    return (message.locations ?? []).some(
      ({ account, folder }) => folders.includes(folder) && isOurs(account),
    );
  };

export const isThreadInScope =
  <T extends { readonly address: string }>(scope: SearchScope<T>) =>
  ({ messages }: ThreadState): boolean =>
    messages.some(isMessageInScope(scope));

/** What no server can answer for: a draft, or sent mail the vault holds because no mailbox does. */
export const isHeldInVault = (message: Message): boolean =>
  message.isDraft === true || (message.locations ?? []).some(copy => !isServerCopy(copy));
