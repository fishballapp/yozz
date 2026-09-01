import { z } from 'zod';
import type { ComposeDraft } from '../state/mail';
import type { AddressRecord } from './addresses';
import { quoteForReply } from './mail-format';
import { type Message, newestInbound, type Thread } from './thread';

/** `?compose=` carries the intent, never the draft. See DECISIONS.md, "The composer's INTENT is in the URL". */
export const composeIntentSchema = z.union([
  z.literal('new'),
  z.templateLiteral(['reply:', z.string().min(1)]),
  z.templateLiteral(['reply-all:', z.string().min(1)]),
  z.templateLiteral(['forward:', z.string().min(1)]),
  /** Named by the stable key, not a versioned `draftId`. Opening is a read, never a create. */
  z.templateLiteral(['draft:', z.string().min(1)]),
]);

export type ComposeIntent = z.infer<typeof composeIntentSchema>;

/** The two search-param reducers every navigation uses. `keepCompose` carries a draft forward and drops `?q=`. */
export const keepCompose = (previous: { compose?: ComposeIntent }) => ({
  compose: previous.compose,
});

/** Opens the composer, preserving everything else about where you are. */
export const withCompose =
  (intent: ComposeIntent) =>
  <T extends { compose?: ComposeIntent }>(previous: T) => ({ ...previous, compose: intent });

/** Closes the composer, leaving you where you were reading. */
export const withoutCompose = <T extends { compose?: ComposeIntent }>(previous: T) => ({
  ...previous,
  compose: undefined,
});

/** Names a message, not a thread: every message can be replied to, and `?compose=` is valid on Settings with no thread in the path. */
const messageIdOfIntent = (intent: ComposeIntent) =>
  intent === 'new' || intent.startsWith('draft:')
    ? undefined
    : intent.slice(intent.indexOf(':') + 1);

/** The draft key a `draft:` intent names. */
export const draftKeyOfIntent = (intent: ComposeIntent): string | null =>
  intent.startsWith('draft:') ? intent.slice('draft:'.length) : null;

/** The same sentence wherever discarding is offered. Tombstoned for 30 days, but no screen brings one back. */
export const DISCARD_WARNING =
  'The message is thrown away and nothing is sent. No screen here brings a discarded draft back.';

/** Measured against the draft as it opened: a reply opens with a recipient, subject and quote already in it. */
export const isUntouched = (draft: ComposeDraft, opened: ComposeDraft): boolean =>
  draft.attachments.length === 0 &&
  (['to', 'cc', 'bcc', 'subject', 'body'] as const).every(field => draft[field] === opened[field]);

/** Everyone the message was addressed to, minus your own addresses and the sender. The empty array is also "hide the button". */
export const replyAllCc = (
  message: Message,
  ownedAddresses: readonly string[],
): readonly string[] => {
  const drop = new Set(
    [...ownedAddresses, message.fromAddress].map(address => address.toLowerCase()),
  );
  return (message.recipients ?? []).filter(address => !drop.has(address.toLowerCase()));
};

/**
 * Rebuilt from the mail, since the intent may arrive from a pasted URL. What is quoted is
 * per-message; who it is addressed to and which identity sends is per-thread, from the newest
 * message that arrived. Forward is per-message throughout.
 */
export const seedFor = (
  intent: ComposeIntent,
  threads: readonly Thread[],
  identities: readonly AddressRecord[],
  ownedAddresses: readonly string[],
): Partial<ComposeDraft> => {
  const messageId = messageIdOfIntent(intent);
  if (messageId === undefined) return {};

  const thread = threads.find(candidate =>
    candidate.messages.some(message => message.id === messageId),
  );
  const message = thread?.messages.find(candidate => candidate.id === messageId);
  if (thread === undefined || message === undefined) return {};

  // Fixed for the whole thread whichever message you pressed. The `??` is unreachable, but
  // `newestInbound` indexes an array.
  const inbound = newestInbound(thread, ownedAddresses) ?? message;
  const identityId = (
    identities.find(identity => identity.address === inbound.toAddress) ?? identities[0]
  )?.address;

  if (intent.startsWith('reply:') || intent.startsWith('reply-all:')) {
    // The group is a fact about the thread; your own sent copy lists whoever you reached that time.
    const cc = intent.startsWith('reply-all:') ? replyAllCc(inbound, ownedAddresses) : [];
    return {
      identityId,
      to: inbound.fromAddress,
      ...(cc.length > 0 ? { cc: cc.join(', ') } : {}),
      subject: thread.subject.startsWith('Re: ') ? thread.subject : `Re: ${thread.subject}`,
      // `>` is both the mail convention and markdown's blockquote.
      body: quoteForReply(message),
      ...(message.messageId !== undefined
        ? {
            inReplyTo: message.messageId,
            // RFC 5322 §3.6.4: the parent's chain, then the parent. Deduplicated.
            references: [
              ...new Set([...(message.references ?? []), message.messageId]),
            ] as readonly string[],
          }
        : {}),
    };
  }

  return {
    identityId,
    subject: thread.subject.startsWith('Fwd: ') ? thread.subject : `Fwd: ${thread.subject}`,
    body: quoteForReply(message),
    attachments: [...(message.attachments ?? [])],
  };
};
