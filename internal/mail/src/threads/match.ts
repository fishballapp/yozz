import type { SearchQuery, TermField } from './query.ts';
import type { Message, Recipient, ThreadState } from './thread.ts';

/** Both halves of the comparison folded, so servers' case-insensitive SEARCH and this one agree. */
export const includesText = (haystack: string, text: string) =>
  haystack.toLowerCase().includes(text.toLowerCase());

const namesAndAddresses = (recipients: readonly Recipient[] | undefined) =>
  (recipients ?? []).flatMap(({ name, address }) => [
    ...(name === undefined ? [] : [name]),
    address,
  ]);

/**
 * Everything of one message a search reads, by the field an operator names. Searching inside
 * attachments would plug in here.
 */
export const searchableFieldsOf = (message: Message, subject: string) => ({
  subject,
  from: [message.fromName, message.fromAddress],
  // A draft has no `to` yet, only the line as typed; elsewhere `toAddress` is who holds a copy.
  to:
    message.to === undefined
      ? [message.toAddress]
      : namesAndAddresses([...message.to, ...(message.cc ?? [])]),
  replyTo: namesAndAddresses(message.replyTo),
  bcc: namesAndAddresses(message.bcc),
  attachmentNames: [
    ...(message.attachmentNames ?? []),
    ...(message.attachments ?? []).map(({ name }) => name),
  ],
  body: message.body.join(' '),
});

type SearchableFields = ReturnType<typeof searchableFieldsOf>;

const SEARCHED_BY: Readonly<Record<TermField, (fields: SearchableFields) => readonly string[]>> = {
  any: ({ subject, from, to, replyTo, bcc, attachmentNames, body }) => [
    subject,
    ...from,
    ...to,
    ...replyTo,
    ...bcc,
    ...attachmentNames,
    body,
  ],
  from: ({ from }) => from,
  to: ({ to }) => to,
  subject: ({ subject }) => [subject],
};

const startOfDay = (day: Temporal.PlainDate) => day.toZonedDateTime('UTC').epochMilliseconds;

/** Every term and flag in this one message, and its time inside every date. */
export const messageMatches = (
  { terms, isUnread, isStarred, before, after }: SearchQuery,
  message: Message,
  subject: string,
): boolean => {
  const fields = searchableFieldsOf(message, subject);
  return (
    (!isUnread || message.isUnread === true) &&
    (!isStarred || message.isStarred === true) &&
    terms.every(({ field, text }) =>
      SEARCHED_BY[field](fields).some(value => includesText(value, text)),
    ) &&
    before.every(day => message.at < startOfDay(day)) &&
    after.every(day => message.at >= startOfDay(day))
  );
};

/**
 * One message holds it all. A write still pending shows on the conversation alone, so the
 * conversation's flag decides first, and a flag no message carries yet asks nothing of them.
 */
export const threadMatches =
  (query: SearchQuery) =>
  (thread: ThreadState): boolean => {
    if ((query.isUnread && !thread.isUnread) || (query.isStarred && !thread.isStarred)) {
      return false;
    }
    const asked = {
      ...query,
      isUnread: query.isUnread && thread.messages.some(({ isUnread }) => isUnread === true),
      isStarred: query.isStarred && thread.messages.some(({ isStarred }) => isStarred === true),
    };
    return thread.messages.some(message => messageMatches(asked, message, thread.subject));
  };
