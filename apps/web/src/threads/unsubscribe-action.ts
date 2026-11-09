import { type Message, offeredUnsubscribe, type ThreadState } from '@yozz.app/mail/threads/thread';
import { mailtoDraftOf } from '@yozz.app/mail/threads/unsubscribe';

/** What pressing Unsubscribe on a message does. Neither form sends anything. */
export type UnsubscribeAction =
  /** The sender's own page, in a new tab. */
  | { readonly kind: 'open-link'; readonly href: string }
  /** A new draft to the sender's `mailto:` address; the person presses Send. */
  | { readonly kind: 'write-draft' };

/**
 * The action a message offers, or null (`offeredUnsubscribe`). A link is the fewest steps, so it
 * wins when both forms are offered. A `mailto:` is offered only when the composer can start from it
 * (`seedFor`), or a button would appear that seeds nothing.
 */
export const unsubscribeActionOf = (
  message: Pick<Message, 'unsubscribe' | 'isDraft'>,
  thread: Pick<ThreadState, 'folders'>,
): UnsubscribeAction | null => {
  const offer = offeredUnsubscribe(message, thread);
  if (offer?.https !== undefined) return { kind: 'open-link', href: offer.https };
  if (offer?.mailto !== undefined && mailtoDraftOf(offer.mailto) !== null) {
    return { kind: 'write-draft' };
  }
  return null;
};
