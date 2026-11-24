import type { Message } from './thread.ts';

/**
 * A mailing list's rewrite of a sender who has no name of their own, as Google Groups and Mailman
 * write it: `'alice@gmail.com' via Some Group`. The address is who wrote to the list, and the From is
 * the list's. Strict by construction: an optionally quoted address of ASCII address characters, one
 * ordinary space, `via`, one ordinary space, then an ASCII letter or digit. Nothing blank or
 * invisible can sit in an ASCII-only token, and the first character of the list's name is visible.
 * (A list named in another script shows its address in the row, the safe way to miss.)
 */
const LIST_REWRITE = /^(["']?)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\1 via [A-Za-z0-9]/u;

/** After NFKC, so the full-width `＠` and the small `﹫` count as the `@` they stand for. */
const holdsAt = (text: string) => text.normalize('NFKC').includes('@');

/**
 * Whether a display name is, or may be read as, an email address: it holds an `@`. `"billing@stripe.com"
 * <scam@evil.top>` shows as Stripe in a row that names a sender by their name, and no reading of the
 * address out of the name is complete (a hyphen of another kind, a blank that is not whitespace, a
 * mark nobody has assigned yet each got past one in review), so none is attempted: the name is
 * not used. Thunderbird does the same.
 *
 * The one exemption is the list rewrite above, with no other `@` after it.
 */
export const nameHoldsAnAddress = (fromName: string): boolean => {
  if (!holdsAt(fromName)) return false;
  const rewrite = LIST_REWRITE.exec(fromName);
  return rewrite === null || holdsAt(fromName.slice(rewrite[0].length));
};

/**
 * Who a list names as a message's sender: their name, or their From address when the name holds an
 * `@`, so a row cannot pass one off as the other. A sender whose name is their own address loses
 * nothing; one with a handle in it (`Alice @acme`) shows their address. Opened mail, the CLI and the
 * agent tools show name and address together and need no such choice.
 */
export const senderLabelOf = ({
  fromName,
  fromAddress,
}: Pick<Message, 'fromName' | 'fromAddress'>): string =>
  fromAddress !== '' && nameHoldsAnAddress(fromName) ? fromAddress : fromName;
