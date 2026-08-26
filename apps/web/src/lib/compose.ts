import { z } from 'zod';
import type { ComposeDraft } from '../state/mail';
import type { AddressRecord } from './addresses';
import { quoteForReply } from './mail-format';
import { type Message, newestInbound, type Thread } from './thread';

/**
 * `?compose=` carries the INTENT to compose, never the draft.
 *
 * That split is the whole design: the URL says *which* message you are writing — a blank one, a
 * reply to this thread, a reply to everyone on it, a forward of it — and the store holds what you have typed. A body in a
 * query string would be shared, logged and truncated by things that have no business reading mail,
 * and it would grow the URL by a paragraph per keystroke.
 *
 * What it buys: back closes the composer, a draft survives switching mailboxes (the param is
 * carried through every navigation), and there is somewhere for `mailto:` to land the day YOZZ
 * registers as a handler.
 */
export const composeIntentSchema = z.union([
  z.literal('new'),
  z.templateLiteral(['reply:', z.string().min(1)]),
  z.templateLiteral(['reply-all:', z.string().min(1)]),
  z.templateLiteral(['forward:', z.string().min(1)]),
]);

export type ComposeIntent = z.infer<typeof composeIntentSchema>;

/**
 * The two search-param reducers every navigation in the app uses. They live beside the param they
 * are about, because **which params survive a navigation is load-bearing and invisible when wrong**
 * — a link that states a whole search object silently drops the ones it does not name. Spelt out
 * inline at each callsite the rule drifts between files, and nothing fails loudly when it does.
 *
 * `keepCompose` carries a draft forward and drops `?q=`: a draft is yours and follows you between
 * mailboxes, a search belongs to the mailbox you ran it in.
 */
export const keepCompose = (previous: { compose?: ComposeIntent }) => ({
  compose: previous.compose,
});

/** Opens the composer while preserving everything else about where you are. */
export const withCompose =
  (intent: ComposeIntent) =>
  <T extends { compose?: ComposeIntent }>(previous: T) => ({ ...previous, compose: intent });

/** Closes the composer and leaves you exactly where you were reading. */
export const withoutCompose = <T extends { compose?: ComposeIntent }>(previous: T) => ({
  ...previous,
  compose: undefined,
});

/**
 * It names a MESSAGE, not a thread, because every message in a thread can be replied to and
 * forwarded — including your own. Replying to your own last message is a follow-up, and the thing
 * that has to be quoted is the message you pressed the button on.
 *
 * A message id is safe to use alone: mail gives every message a globally unique id, so the intent
 * does not need the thread beside it to be resolvable. That matters because `?compose=` is a root
 * param and is valid on Settings, where no thread is in the path to lean on.
 */
const messageIdOfIntent = (intent: ComposeIntent) =>
  intent === 'new' ? undefined : intent.slice(intent.indexOf(':') + 1);

/**
 * Who Reply all adds beyond Reply: everyone the message was addressed to, minus every address you
 * own and minus the sender, who is already the `To`.
 *
 * One helper serves both the seed and the button, because they have to agree. Offering Reply all
 * on a message where it would produce the same mail as Reply is the whole failure mode — the empty
 * array IS the answer to "should this be on screen", so there is nowhere for the two to drift.
 */
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
 * The draft an intent opens with, rebuilt from the mail rather than passed along with the click.
 *
 * It has to be rebuildable, because the intent may arrive from a pasted URL or a back button rather
 * than from the Reply button that first produced it — so the seed cannot live in the event handler.
 *
 * **What is quoted is per-message; who it is addressed to is per-thread.** Those are different
 * questions and conflating them is the bug this shape exists to avoid. Pressing Reply under your
 * own last message is a *follow-up*: the thing to quote is what you wrote, but the recipient is
 * still the person on the other end of the thread — replying to yourself is never what was meant.
 * So the quote comes from the message you pressed, and the recipient and the sending identity both
 * come from the newest message that ARRIVED.
 *
 * Forward is per-message throughout, attachments included: forwarding is about the one message you
 * are looking at, and it has no recipient yet by definition.
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

  // Who the thread is WITH, and which of your addresses it reaches you on — both fixed for the
  // whole thread, whichever message you happened to press.
  // The `??` is unreachable — the thread demonstrably has this message in it — but `newestInbound`
  // indexes an array, and narrowing that with a typed fallback beats asserting it away.
  const inbound = newestInbound(thread, ownedAddresses) ?? message;
  const identityId = (
    identities.find(identity => identity.address === inbound.toAddress) ?? identities[0]
  )?.address;

  if (intent.startsWith('reply:') || intent.startsWith('reply-all:')) {
    // Reply all copies the recipients of the message that ARRIVED, for the same reason the To
    // comes from there: the group is a fact about the thread, not about whichever message you
    // pressed — and your own sent copy lists whoever you happened to reach that time.
    const cc = intent.startsWith('reply-all:') ? replyAllCc(inbound, ownedAddresses) : [];
    return {
      identityId,
      to: inbound.fromAddress,
      ...(cc.length > 0 ? { cc: cc.join(', ') } : {}),
      subject: thread.subject.startsWith('Re: ') ? thread.subject : `Re: ${thread.subject}`,
      // Replies quote the original, the way mail has always done it — and `>` is both the mail
      // convention and markdown's blockquote, so it survives either reading.
      body: quoteForReply(message),
      ...(message.messageId !== undefined ? { inReplyTo: message.messageId } : {}),
    };
  }

  return {
    identityId,
    subject: thread.subject.startsWith('Fwd: ') ? thread.subject : `Fwd: ${thread.subject}`,
    body: quoteForReply(message),
    attachments: [...(message.attachments ?? [])],
  };
};
