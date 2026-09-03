import { z } from 'zod';
import type { ComposeDraft } from './draft';
import type { ComposeIntent } from './intent';

/**
 * The open draft, on the device, so the reload a stale build triggers (`main.tsx`) does not eat
 * it. Keyed by user and the `?compose=` intent, so only a draft for that intent is restored.
 * Attachment bytes are not stored. Cleared on lock, discard and a send that went out.
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
    /** Which vault record this text already is; without it a reload minted a second record (DECISIONS.md). The version is a hint the restore re-checks. */
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
    // A record that does not parse must not break every attempt to compose.
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
