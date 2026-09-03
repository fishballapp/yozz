/**
 * Pure: message ids in, groups out. JMAP's rule (RFC 8621 §3) under union-find, with Gmail's
 * `X-GM-THRID` as one extra edge scoped to its account. See docs/knowledge/email-threading.md
 * and DECISIONS.md, "Threading is union-find over JMAP's rule".
 */

export type ThreadableMessage = {
  /** Any id unique across the input; a group is named by the first of its members in input order. */
  readonly id: string;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly subject: string | null;
  readonly gmailThreadId: string | null;
  /** A THRID is Gmail's number inside one mailbox, so two accounts can hand out the same one. */
  readonly gmailAccount?: string;
};

// ponytail: RFC 5256's leaders plus the localized Outlook set the knowledge doc lists; extend
// when a real subject splits a thread.
const LEADER =
  /^(?:(?:re|fw|fwd|aw|wg|sv|vs|odp|pd|r|rif|ref|res|antwort|doorst|tr|回复|答复|回覆|轉寄|转发)\s*(?:\[\d+\]|\(\d+\))?\s*:\s*)+/i;
const LIST_TAG = /^\[[^\]]*\]\s*/;
const FWD_TRAILER = /\s*\(fwd\)\s*$/i;

/** RFC 5256 §2.1's base subject, case-folded, with a wider prefix list. */
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

/** `In-Reply-To` may hold several ids (RFC 5322 §3.6.4) and CFWS; a bare unbracketed id is wrapped. */
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

/** The key is the earliest member's id in input order, so a thread keeps its id until an older message is backfilled. */
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
    // An extra edge, never a replacement: the headers are what link the copies other accounts hold.
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
