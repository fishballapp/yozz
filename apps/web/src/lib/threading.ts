/**
 * Which messages are one conversation. Pure: message ids in, groups of ids out.
 *
 * Gmail's own answer (`X-GM-THRID`) is one edge among the others, scoped to the account that
 * issued it. Everything else follows JMAP's recommendation (RFC 8621 §3): two messages share a
 * thread when an identical msg-id appears in either's `Message-ID` / `In-Reply-To` / `References`
 * AND their base subjects match. Union-find over that relation, rather than JWZ's tree, because
 * the list shows a flat conversation and never a tree
 * (docs/knowledge/email-threading.md).
 */

export type ThreadableMessage = {
  /** Any id unique across the input; a group is named by the FIRST of its members in input order. */
  readonly id: string;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string | null;
  readonly gmailThreadId: string | null;
  /**
   * Which account the Gmail thread id belongs to. A THRID is Gmail's own number for a
   * conversation inside ONE mailbox, so two accounts can hand out the same one for unrelated
   * mail; scoping it keeps that from merging strangers. Absent for a message with no THRID.
   */
  readonly gmailAccount?: string;
};

// ponytail: RFC 5256's leaders plus the localized Outlook set the knowledge doc lists; extend
// when a real subject splits a thread.
const LEADER =
  /^(?:(?:re|fw|fwd|aw|wg|sv|vs|odp|pd|r|rif|ref|res|antwort|doorst|tr|回复|答复|回覆|轉寄|转发)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;
const LIST_TAG = /^\[[^\]]*\]\s*/;
const FWD_TRAILER = /\s*\(fwd\)\s*$/i;

/** RFC 5256 §2.1's base subject, case-folded and with a wider prefix list than the RFC's. */
export const baseSubject = (subject: string | null): string => {
  let text = (subject ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (;;) {
    const before = text;
    text = text.replace(FWD_TRAILER, '');
    text = text.replace(LEADER, '');
    const untagged = text.replace(LIST_TAG, '');
    if (untagged !== '' && untagged !== text) text = untagged;
    const wrapped = text.match(/^\[fwd:\s*(.*)\]$/);
    if (wrapped?.[1] !== undefined) text = wrapped[1].trim();
    if (text === before) return text;
  }
};

/**
 * Every msg-id in a header field. `In-Reply-To` may legally hold several (RFC 5322 §3.6.4), and
 * a value may carry CFWS, so the bracketed ids are pulled out; a bare unbracketed id (some MUAs)
 * is wrapped. `References` arrives pre-split, so its entries pass straight through this.
 */
const msgIdsIn = (field: string | null): readonly string[] => {
  if (field === null) return [];
  const bracketed = field.match(/<[^<>\s]+>/g);
  if (bracketed !== null) return bracketed;
  const trimmed = field.trim();
  return trimmed === '' ? [] : [`<${trimmed}>`];
};

const msgIdsOf = (message: ThreadableMessage): readonly string[] => [
  ...msgIdsIn(message.messageId),
  ...msgIdsIn(message.inReplyTo),
  ...message.references.flatMap(msgIdsIn),
];

/**
 * Groups by conversation. The key of each group is the id of its EARLIEST member in input order,
 * which is what a thread id is built from. Callers pass messages oldest first, so a thread keeps
 * its id through every later sync and every move until an older message is backfilled, and a
 * route that names it keeps resolving.
 */
export const groupIntoThreads = (
  messages: readonly ThreadableMessage[],
): ReadonlyMap<string, readonly string[]> => {
  const order = new Map(messages.map((message, index) => [message.id, index]));
  const rank = (id: string) => order.get(id) ?? Number.POSITIVE_INFINITY;
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank(ra) < rank(rb)) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  const firstByKey = new Map<string, string>();
  const link = (key: string, id: string) => {
    const first = firstByKey.get(key);
    if (first === undefined) firstByKey.set(key, id);
    else union(first, id);
  };

  for (const message of messages) {
    // A THRID is an EXTRA edge, never a replacement for the header edges: it links what Gmail
    // considers one conversation inside one account, and the headers are what link that
    // conversation to the copies other accounts hold. Taking the THRID and skipping the headers
    // (which this did) meant two accounts in one conversation never joined.
    if (message.gmailThreadId !== null) {
      link(`gmail:${message.gmailAccount ?? ''}:${message.gmailThreadId}`, message.id);
    }
    const subject = baseSubject(message.subject);
    for (const id of msgIdsOf(message)) link(`${subject}\0${id}`, message.id);
  }

  const groups = new Map<string, string[]>();
  for (const { id } of messages) {
    const root = find(id);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [id]);
    else group.push(id);
  }
  return groups;
};
