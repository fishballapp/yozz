import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { SeedRequest } from '@yozz.app/mail/compose/seed';
import { newestInbound, type Thread } from '@yozz.app/mail/threads/thread';
import { z } from 'zod';

/** `?compose=` carries the intent, never the draft. See DECISIONS.md, "The composer's INTENT is in the URL". */
export const composeIntentSchema = z.union([
  z.literal('new'),
  z.templateLiteral(['reply:', z.string().min(1)]),
  z.templateLiteral(['reply-all:', z.string().min(1)]),
  z.templateLiteral(['forward:', z.string().min(1)]),
  /** The `mailto:` a message's List-Unsubscribe offers, as a new draft for the person to send. */
  z.templateLiteral(['unsubscribe:', z.string().min(1)]),
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

const SEED_KINDS = [
  'reply',
  'reply-all',
  'forward',
  'unsubscribe',
] as const satisfies readonly SeedRequest['kind'][];

/**
 * The message an intent answers or passes on, if any. Names a message, not a thread: every message
 * can be replied to, and `?compose=` is valid on Settings with no thread in the path.
 */
export const seedRequestOf = (intent: ComposeIntent): SeedRequest | null => {
  const kind = SEED_KINDS.find(candidate => intent.startsWith(`${candidate}:`));
  return kind === undefined ? null : { kind, messageId: intent.slice(kind.length + 1) };
};

/** The draft key a `draft:` intent names. */
export const draftKeyOfIntent = (intent: ComposeIntent): string | null =>
  intent.startsWith('draft:') ? intent.slice('draft:'.length) : null;

/** A reply or a forward keeps the message it answers on screen beside it, where there is room. */
export const answersMessage = (intent: ComposeIntent): boolean => {
  const kind = seedRequestOf(intent)?.kind;
  return kind === 'reply' || kind === 'reply-all' || kind === 'forward';
};

/**
 * What the composer is called, from the intent alone. A reply names who it goes to, read from the
 * same message `seedFor` addresses it from; a thread that is all your own mail has nobody to name.
 */
export const composeTitleOf = (
  intent: ComposeIntent,
  threads: readonly Thread[],
  ownedAddresses: readonly string[],
): string => {
  const request = seedRequestOf(intent);
  if (request?.kind === 'reply-all') return 'Reply all';
  if (request?.kind === 'forward') return 'Forward';
  if (request?.kind !== 'reply') return 'New message';
  const thread = threads.find(candidate =>
    candidate.messages.some(message => message.id === request.messageId),
  );
  const inbound = thread === undefined ? undefined : newestInbound(thread, ownedAddresses);
  const isFromSomeoneElse =
    inbound !== undefined &&
    !ownedAddresses.some(owned => owned.toLowerCase() === inbound.fromAddress.toLowerCase());
  return isFromSomeoneElse ? `Reply to ${inbound.fromName}` : 'Reply';
};

/** The same sentence wherever discarding is offered. Tombstoned for 30 days, but no screen brings one back. */
export const DISCARD_WARNING = "It's deleted for good. Nothing is sent.";

/** Measured against the draft as it opened: a reply opens with a recipient, subject and quote already in it. */
export const isUntouched = (draft: ComposeDraft, opened: ComposeDraft): boolean =>
  // By id: a forward opens holding its files, and a retry or a removal changes which.
  draft.attachments.map(({ id }) => id).join(' ') ===
    opened.attachments.map(({ id }) => id).join(' ') &&
  (['to', 'cc', 'bcc', 'subject', 'body'] as const).every(field => draft[field] === opened[field]);
