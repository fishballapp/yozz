import { z } from 'zod';
import type { ComposeDraft } from '../state/mail';
import type { ComposeIntent } from './compose';

/**
 * The open draft, kept on the device so a reload does not eat it. A deploy retires the old
 * chunk files, so the first lazy import after one fails and the app reloads itself
 * (`main.tsx`); without this the message you were writing would be the price of the upgrade.
 *
 * Keyed by user and remembered with the `?compose=` intent it belongs to: on reload the intent is
 * still in the URL, and only a draft for THAT intent is restored — a stored reply never lands in a
 * fresh blank message. Attachment bytes are not stored; files are re-picked. Cleared on lock, on
 * discard and on a send that went out, like the rest of the user's plaintext.
 */
const storedDraftSchema = z.object({
  intent: z.string(),
  draft: z.object({
    startedAsReply: z.boolean(),
    identityId: z.string(),
    to: z.string(),
    cc: z.string(),
    bcc: z.string(),
    subject: z.string(),
    body: z.string(),
    inReplyTo: z.string().optional(),
    references: z.array(z.string()).optional(),
    /**
     * Which vault record this text already IS, when it has reached one.
     *
     * Without them a reload restored the words and lost the identity, so the autosave read a
     * draft with no `draftId`, took its create branch, and minted a SECOND record holding the
     * same message — once per reload, for as long as you kept reloading. The key is the stable
     * one; the version is a hint the restore re-checks against the live records.
     */
    draftKey: z.string().optional(),
    draftId: z.string().optional(),
  }),
});

const keyOf = (userId: string) => `yozz:draft:${userId}`;

export const saveDraft = (
  userId: string,
  intent: ComposeIntent,
  draft: ComposeDraft,
  storage: Storage = localStorage,
): void => {
  const { attachments: _files, ...rest } = draft;
  storage.setItem(keyOf(userId), JSON.stringify({ intent, draft: rest }));
};

/** The stored draft for exactly this intent, or nothing. */
export const loadDraft = (
  userId: string,
  intent: ComposeIntent,
  storage: Storage = localStorage,
): ComposeDraft | null => {
  const raw = storage.getItem(keyOf(userId));
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // A record that does not even parse would otherwise break every attempt to compose.
    storage.removeItem(keyOf(userId));
    return null;
  }
  const parsed = storedDraftSchema.safeParse(json);
  if (!parsed.success || parsed.data.intent !== intent) return null;
  return { ...parsed.data.draft, attachments: [] };
};

export const clearDraft = (userId: string, storage: Storage = localStorage): void => {
  storage.removeItem(keyOf(userId));
};
