import type { AddressRecord } from '../addresses/record.ts';
import { type Message, newestInbound, type Thread } from '../threads/thread.ts';
import { fullTime } from '../time.ts';
import type { ComposeDraft } from './draft.ts';

/**
 * Where a reply goes: the message's Reply-To (RFC 5322 §3.6.2) minus your own addresses, else its
 * sender. A list echoing your post back with `Reply-To: you` is answered on the list, not to you.
 */
const replyAddresses = (message: Message, ownedAddresses: readonly string[]): readonly string[] => {
  const owned = new Set(ownedAddresses.map(address => address.toLowerCase()));
  const others = (message.replyTo ?? [])
    .map(({ address }) => address)
    .filter(address => !owned.has(address.toLowerCase()));
  return others.length > 0 ? others : [message.fromAddress];
};

/** Everyone the message was addressed to, minus your own addresses, the sender and whoever the reply already goes to. The empty array is also "hide the button". */
export const replyAllCc = (
  message: Message,
  ownedAddresses: readonly string[],
): readonly string[] => {
  const drop = new Set(
    [...ownedAddresses, message.fromAddress, ...replyAddresses(message, ownedAddresses)].map(
      address => address.toLowerCase(),
    ),
  );
  const addressed = [...(message.to ?? []), ...(message.cc ?? [])].map(({ address }) =>
    address.toLowerCase(),
  );
  // One address twice, differently cased, is one recipient.
  return [...new Set(addressed)].filter(address => !drop.has(address));
};

/** A message to answer or pass on, named by its id in the thread graph. */
export type SeedRequest = {
  readonly kind: 'reply' | 'reply-all' | 'forward';
  readonly messageId: string;
};

/**
 * Rebuilt from the mail, since the request may arrive from a pasted URL or a command line. What is quoted is
 * per-message; who it is addressed to and which identity sends is per-thread, from the newest
 * message that arrived. Forward is per-message throughout.
 */
export const seedFor = (
  { kind, messageId }: SeedRequest,
  threads: readonly Thread[],
  identities: readonly AddressRecord[],
  ownedAddresses: readonly string[],
): Partial<ComposeDraft> => {
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

  if (kind === 'reply' || kind === 'reply-all') {
    // The group is a fact about the thread; your own sent copy lists whoever you reached that time.
    const cc = kind === 'reply-all' ? replyAllCc(inbound, ownedAddresses) : [];
    return {
      identityId,
      to: replyAddresses(inbound, ownedAddresses).join(', '),
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

/** `>` is both mail's quoting convention and markdown's blockquote, so it survives either reading. */
export const quoteForReply = (message: Message) =>
  [
    '',
    '',
    `On ${fullTime(message.at)}, ${message.fromName} <${message.fromAddress}> wrote:`,
    '',
    // `>` separates paragraphs, so it belongs between them, or every draft ends in a bare `>`.
    ...message.body.flatMap((paragraph, index) =>
      index === 0 ? [`> ${paragraph}`] : ['>', `> ${paragraph}`],
    ),
  ].join('\n');
