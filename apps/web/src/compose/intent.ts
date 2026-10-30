import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { SeedRequest } from '@yozz.app/mail/compose/seed';
import { z } from 'zod';

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

const SEED_KINDS = [
  'reply',
  'reply-all',
  'forward',
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

/** The same sentence wherever discarding is offered. Tombstoned for 30 days, but no screen brings one back. */
export const DISCARD_WARNING =
  'The message is thrown away and nothing is sent. No screen here brings a discarded draft back.';

/** Measured against the draft as it opened: a reply opens with a recipient, subject and quote already in it. */
export const isUntouched = (draft: ComposeDraft, opened: ComposeDraft): boolean =>
  draft.attachments.length === 0 &&
  (['to', 'cc', 'bcc', 'subject', 'body'] as const).every(field => draft[field] === opened[field]);
