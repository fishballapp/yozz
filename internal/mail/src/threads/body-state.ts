import type { Location, Message, ThreadState } from './thread.ts';

/** A parsed body (attachment bytes included) is cached only when the raw message was under this. */
// ponytail: one ceiling; attachments-without-bytes would let bigger mail cache too.
export const MAX_CACHED_BODY_BYTES = 1024 * 1024;

/** Kept beside the base: a sync rebuilding the threads must not blank the message being read. */
/** The message's fields, or a failure the reader can retry. */
export type BodyOutcome =
  | { readonly status: 'failed' }
  | ({ readonly status: 'loaded' } & Pick<
      Message,
      | 'body'
      | 'html'
      | 'hasTextPart'
      | 'htmlSaysMore'
      | 'inlineImagesTruncated'
      | 'attachments'
      | 'senderCheck'
    >);

export type BodyEntry = { readonly status: 'loading' } | BodyOutcome;

/**
 * The text of every body the device cache holds, keyed by `previewKey`. It fills `body` on a
 * message not yet opened so the row shows its excerpt; `bodyStatus` stays, so opening still loads
 * the HTML and attachments.
 */
export type Previews = Readonly<Record<string, readonly string[]>>;

/** uidValidity is part of the key: after a reset a reused uid must not inherit another message's text. */
export const previewKey = ({ mailbox, folder, uidValidity, uid }: Location) =>
  `${mailbox}/${folder}/${uidValidity}/${uid}`;

export const withoutMailboxPreviews = (previews: Previews, mailbox: string): Previews =>
  Object.fromEntries(Object.entries(previews).filter(([key]) => !key.startsWith(`${mailbox}/`)));

/** A message with its fetched body or cached text laid over it; the same object when neither changes it. */
const withBody = (
  message: Message,
  bodies: Readonly<Record<string, BodyEntry>>,
  previews: Previews,
): Message => {
  const entry = bodies[message.id];
  if (entry?.status === 'loaded') {
    const { status: _, ...fields } = entry;
    return { ...message, ...fields, bodyStatus: undefined };
  }
  if (message.bodyStatus === undefined) return message;
  const preview = message.locations
    ?.map(location => previews[previewKey(location)])
    .find(text => text !== undefined);
  const bodyStatus = entry?.status ?? message.bodyStatus;
  if (preview === undefined && bodyStatus === message.bodyStatus) return message;
  return { ...message, ...(preview === undefined ? {} : { body: [...preview] }), bodyStatus };
};

/** A thread nothing changed stays the same object, so a body landing re-renders its row alone. */
export const withBodies = (
  threads: readonly ThreadState[],
  bodies: Readonly<Record<string, BodyEntry>>,
  previews: Previews = {},
): readonly ThreadState[] =>
  threads.map(thread => {
    const messages = thread.messages.map(message => withBody(message, bodies, previews));
    return messages.every((message, index) => message === thread.messages[index])
      ? thread
      : { ...thread, messages };
  });
