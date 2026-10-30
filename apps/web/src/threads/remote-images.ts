import type { SenderCheck } from '@yozz.app/mail/threads/thread';
import { senderKeyOf } from '@yozz.app/mail/threads/thread';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import { VaultError } from '@yozz.app/vault';
import { z } from 'zod';

/**
 * What the reader remembers about remote images, in the vault so every device agrees: the messages
 * whose images were loaded (one bounded record), and the senders whose images always load (one
 * record each). Both name who you correspond with, so neither may sit anywhere unencrypted.
 */

/**
 * One message's images, loaded once. The sender rides along so a message that reuses a
 * consented Message-ID under another From is another message.
 */
export type ImageConsent = { readonly messageId: string; readonly sender: string };

const consentKeyOf = ({ messageId, sender }: ImageConsent) => `${senderKeyOf(sender)} ${messageId}`;

export const IMAGE_CONSENTS_RECORD_TYPE = 'image-consents';
const IMAGE_CONSENTS_KEY = 'consents';

/**
 * Newest last; past this the oldest is forgotten and that message asks again, which costs a click.
 * 1000 typical ids are ~100 KB; the id ceiling keeps the worst case under half the record limit.
 */
export const MAX_REMEMBERED_CONSENTS = 1000;
/** A longer id (no real Message-ID is) is honoured for the session but not written down. */
export const MAX_REMEMBERED_ID_LENGTH = 300;

const consentsSchema = z.object({
  consents: z.array(z.object({ messageId: z.string(), sender: z.string() })),
});

const parseConsents = (plaintext: string): readonly ImageConsent[] => {
  try {
    const parsed = consentsSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data.consents : [];
  } catch {
    return [];
  }
};

/** `consent` moves to the newest end; the oldest past the bound fall off. */
export const withConsent = (
  consents: readonly ImageConsent[],
  consent: ImageConsent,
): readonly ImageConsent[] =>
  [...consents.filter(existing => consentKeyOf(existing) !== consentKeyOf(consent)), consent].slice(
    -MAX_REMEMBERED_CONSENTS,
  );

export const withoutConsent = (
  consents: readonly ImageConsent[],
  consent: ImageConsent,
): readonly ImageConsent[] =>
  consents.filter(existing => consentKeyOf(existing) !== consentKeyOf(consent));

export const hasConsent = (consents: readonly ImageConsent[], consent: ImageConsent): boolean =>
  consents.some(existing => consentKeyOf(existing) === consentKeyOf(consent));

export const readConsents = async (store: RecordStore) => {
  const opened = await store.get(IMAGE_CONSENTS_RECORD_TYPE, IMAGE_CONSENTS_KEY);
  return opened === null
    ? { consents: [], revision: null }
    : { consents: parseConsents(opened.plaintext), revision: opened.revision };
};

const isConflict = (error: unknown) => error instanceof VaultApiError && error.code === 'CONFLICT';

/** Two devices changing the list at once both land: a refused write re-reads and reapplies. */
const CAS_ATTEMPTS = 3;

/** What this device holds, the list a recovery writes. Called only then. */
type Held = () => readonly ImageConsent[];

const isStale = (error: unknown) => error instanceof VaultError && error.code === 'stale';

/**
 * One compare-and-swap change to the list. Resolves with it as stored; rejects when the vault cannot
 * be reached.
 *
 * A write that never reached the server has still raised this device's revision mark (a write
 * advances it before the PUT), so every later read of the row refuses it as stale, in this session
 * and after a reload. Then the list this device can no longer read is replaced, last write wins,
 * by what it holds; an unconditioned put allocates past the mark, and the row reads again.
 */
const changeConsents = async (
  store: RecordStore,
  change: (consents: readonly ImageConsent[]) => readonly ImageConsent[],
  held: Held,
): Promise<readonly ImageConsent[]> => {
  for (let attempt = 1; ; attempt++) {
    const current = await (async () => {
      try {
        return await readConsents(store);
      } catch (error) {
        if (isStale(error)) return null;
        throw error;
      }
    })();
    if (current === null) {
      // Session-only ids stay unwritten here too.
      const consents = change(
        held().filter(({ messageId }) => messageId.length <= MAX_REMEMBERED_ID_LENGTH),
      );
      await store.put({
        type: IMAGE_CONSENTS_RECORD_TYPE,
        naturalKey: IMAGE_CONSENTS_KEY,
        plaintext: JSON.stringify({ consents }),
      });
      return consents;
    }
    const consents = change(current.consents);
    try {
      await store.put({
        type: IMAGE_CONSENTS_RECORD_TYPE,
        naturalKey: IMAGE_CONSENTS_KEY,
        plaintext: JSON.stringify({ consents }),
        precondition:
          current.revision === null
            ? { expect: 'absent' }
            : { expect: 'revision', revision: current.revision },
      });
      return consents;
    } catch (error) {
      if (!isConflict(error) || attempt === CAS_ATTEMPTS) throw error;
    }
  }
};

export const rememberConsent = (store: RecordStore, consent: ImageConsent, held: Held) =>
  changeConsents(store, consents => withConsent(consents, consent), held);

/** This message only: any other message from the same sender keeps its consent. */
export const forgetConsent = (store: RecordStore, consent: ImageConsent, held: Held) =>
  changeConsents(store, consents => withoutConsent(consents, consent), held);

export const IMAGE_SENDER_RECORD_TYPE = 'image-sender';

const senderSchema = z.object({
  address: z.string(),
  addedAt: z.number(),
  /**
   * Trusted from a message the provider verified: only verified messages from the address load.
   * False when trusted through the warning: every message showing this From loads. Absent on a
   * record from before the warning existed, when every trust was verified-only.
   */
  isVerifiedOnly: z.boolean().default(true),
});

export type TrustedSender = z.infer<typeof senderSchema>;

/** A message loads by trust when its shown From is trusted, and verified if the trust needs it. */
export const isLoadedByTrust = (
  sender: TrustedSender | undefined,
  check: SenderCheck | undefined,
): boolean => sender !== undefined && (!sender.isVerifiedOnly || check?.status === 'verified');

const parseSender = (plaintext: string): TrustedSender | null => {
  try {
    const parsed = senderSchema.safeParse(JSON.parse(plaintext));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** Oldest first, as they were added; an unreadable row is skipped. */
export const listTrustedSenders = async (store: RecordStore): Promise<readonly TrustedSender[]> =>
  (await store.list(IMAGE_SENDER_RECORD_TYPE))
    .flatMap(row => {
      const sender = parseSender(row.plaintext);
      return sender === null ? [] : [sender];
    })
    .toSorted((a, b) => a.addedAt - b.addedAt);

/**
 * Resolves to the trust the vault now holds. Trusting through the warning replaces any record, so
 * the trust widens. A verified-only trust writes only where there is none: a record already there
 * is as wide or wider, and a device that hasn't seen it yet must not narrow it.
 */
export const trustSender = async (
  store: RecordStore,
  sender: TrustedSender,
): Promise<TrustedSender> => {
  const naturalKey = senderKeyOf(sender.address);
  const plaintext = JSON.stringify(sender);
  if (!sender.isVerifiedOnly) {
    await store.put({ type: IMAGE_SENDER_RECORD_TYPE, naturalKey, plaintext });
    return sender;
  }
  try {
    await store.put({
      type: IMAGE_SENDER_RECORD_TYPE,
      naturalKey,
      plaintext,
      precondition: { expect: 'absent' },
    });
    return sender;
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const opened = await store.get(IMAGE_SENDER_RECORD_TYPE, naturalKey);
  const held = opened === null ? null : parseSender(opened.plaintext);
  if (held !== null) return held;
  // Removed or unreadable since: nothing wider to keep.
  await store.put({ type: IMAGE_SENDER_RECORD_TYPE, naturalKey, plaintext });
  return sender;
};

export const forgetSender = (store: RecordStore, address: string): Promise<void> =>
  store.remove(IMAGE_SENDER_RECORD_TYPE, senderKeyOf(address));
