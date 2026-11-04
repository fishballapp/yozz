import { isInbound } from '@yozz.app/mail/addresses/record';
import { addressList } from '@yozz.app/mail/compose/draft';
import { expungeMirror } from '@yozz.app/mail/compose/draft-mirror';
import { draftIdOf, heldSend } from '@yozz.app/mail/compose/draft-record';
import {
  claimSend,
  type DraftHandle,
  readMirror,
  readSendLease,
  reclaimSend,
} from '@yozz.app/mail/compose/draft-vault';
import { envelopeRecipients, storeSentCopy } from '@yozz.app/mail/compose/send';
import { driveSend, type SendEffects } from '@yozz.app/mail/compose/send-machine';
import { sentRecordFrom, storeSentRecord } from '@yozz.app/mail/compose/sent-vault';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { messageIdOf } from '@yozz.app/mail/threads/thread';
import type { FileStore } from '@yozz.app/mail/vault/file-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import * as Clock from 'effect/Clock';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import { Cache, MailboxLayer } from '../cache/cache.ts';
import { reportFailure, SendRefused, SendUnconfirmed, UsageError } from '../errors.ts';
import { Mail } from '../mail/mail.ts';
import { printJson } from '../output.ts';
import { Settings } from '../settings.ts';
import { Vault } from '../vault/vault.ts';
import { claimFor, goneDraft, readDraft, refusedSave } from './drafts.ts';

const UNCONFIRMED =
  "nobody saw whether the mail server took it. Check Sent, and settle it in yozz.app: it won't be sent again from here";

export const sendCommand = Command.make(
  'send',
  {
    draftId: Argument.String('draftId').pipe(
      Argument.withDescription('The versioned draftId the last `yozz draft` printed'),
    ),
  },
  Effect.fn('compose.send')(function* ({ draftId }) {
    const vault = yield* Vault;
    const mail = yield* Mail;
    const cache = yield* Cache;
    const { webUrl } = yield* Settings;
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const { key, version, record } = yield* readDraft(draftId);
    const identity = mail.identities.find(({ address }) => address === record.from);

    /** What a send that went out prints. */
    const sent = ({
      messageId,
      isReplayed,
      sentCopy,
    }: {
      readonly messageId: string;
      readonly isReplayed: boolean;
      readonly sentCopy: 'stored' | 'pending' | 'none';
    }) => {
      // Any message id in a conversation names it: a reply's is the message it answers.
      const threadId = record.threadId ?? messageIdOf(record.inReplyTo ?? messageId);
      return printJson({
        sent: true,
        replayed: isReplayed,
        messageId: messageIdOf(messageId),
        threadId,
        sentCopy,
        url: `${webUrl}/m/sent/t/${encodeURIComponent(threadId)}`,
      });
    };

    // Sent already: a repeated send reports it, and never submits again.
    if (record.deletedAt !== undefined) {
      if (record.sentMessageId === undefined) return yield* goneDraft(draftId, record);
      return yield* sent({
        messageId: record.sentMessageId,
        isReplayed: true,
        sentCopy: record.isSentWithoutCopy === true ? 'none' : 'stored',
      });
    }
    // Another device or run is at it now, which is not the question below.
    const renewedAt = yield* vault.use(store => readSendLease(store, record));
    if (heldSend(record, renewedAt, now()) !== undefined) {
      return yield* refusedSave(draftId, { ok: false, reason: 'sending' });
    }
    const unsettled = record.unconfirmedSend ?? record.send;
    if (unsettled?.state === 'submitting' || unsettled?.state === 'unconfirmed') {
      return yield* new SendUnconfirmed({
        message: `The draft ${draftId} was sent before, and ${UNCONFIRMED}`,
      });
    }

    /** One implementation of each phase, for a fresh send and a resumed one, as the web app's. */
    const effectsOf = (store: RecordStore, files: FileStore): SendEffects => ({
      store,
      readFile: files.get,
      submit: async (bytes, { record: claimed }) => {
        // Only a resumed send can lack it, and a resumed one never submits.
        if (identity === undefined) {
          return { ok: false, error: { kind: 'error', detail: 'That address was removed' } };
        }
        return mail.submit(
          identity,
          bytes,
          envelopeRecipients({
            to: addressList(claimed.to),
            cc: addressList(claimed.cc),
            bcc: addressList(claimed.bcc),
          }),
        );
      },
      copyToSent: async (target, { message, assembleCopy }, handle) => {
        const messageId = handle.record.send?.messageId ?? '';
        if (target === 'vault' || (identity !== undefined && !isInbound(identity))) {
          try {
            await storeSentRecord(store, sentRecordFrom(handle.record, messageId, message, now()));
          } catch (error) {
            // The copy's failure alone: the message went out.
            return { ok: false, error: { kind: 'error', detail: String(error) } };
          }
          return { ok: true, value: null };
        }
        // The address's mailbox was removed since the claim: the send finishes without a copy in it.
        const mailbox = mail.mailboxes.find(({ address }) => address === handle.record.from);
        if (mailbox === undefined) return { ok: true, value: null };
        const assembled = await assembleCopy();
        if (!assembled.ok) return assembled;
        const copied = await storeSentCopy(mail.runOn(mailbox), assembled.value, messageId);
        if (!copied.ok) return copied;
        return { ok: true, value: copied.value === null ? null : { ...target, ...copied.value } };
      },
      // Phase (4), best effort: only a copy yozz.app mirrored has a locator to erase.
      expungeMirror: async ({ draftKey }) => {
        const mirror = await readMirror(store, draftKey).catch(() => null);
        const mailbox = mail.mailboxes.find(
          ({ address }) => address === mirror?.mirror.locator?.account,
        );
        if (mailbox === undefined) return;
        await expungeMirror(mail.runOn(mailbox), store, draftKey).catch(() => undefined);
      },
      now,
    });

    const claimed: DraftHandle = yield* Effect.gen(function* () {
      // Claimed by an earlier run that got as far as SMTP's yes: finish the copy and the tombstone.
      if (record.send !== undefined) {
        const currentDraftId = draftIdOf(key, record.contentVersion);
        const reclaimed = yield* vault.use(store => reclaimSend(store, currentDraftId, now()));
        if (reclaimed === null) {
          return yield* refusedSave(draftId, { ok: false, reason: 'sending' });
        }
        return reclaimed;
      }
      if (version !== record.contentVersion) {
        return yield* refusedSave(draftId, {
          ok: false,
          reason: 'conflict',
          currentDraftId: draftIdOf(key, record.contentVersion),
        });
      }
      if (identity === undefined) {
        return yield* new UsageError({
          message: `${record.from} is no longer one of your addresses; yozz whoami lists them`,
        });
      }
      const recipients = envelopeRecipients({
        to: addressList(record.to),
        cc: addressList(record.cc),
        bcc: addressList(record.bcc),
      });
      if (recipients.length === 0) {
        return yield* new UsageError({ message: `The draft ${draftId} has no recipients` });
      }
      const send = yield* claimFor({ identity, key, record, now: now() });
      // Phase (0): the message goes into the record, under compare-and-swap on the version named, before
      // SMTP sees them, so no other run or device can send it too.
      const claim = yield* vault.use(store => claimSend(store, draftId, send));
      if (!claim.ok) return yield* refusedSave(draftId, claim);
      return claim.handle;
    });
    const isReplayed = record.send !== undefined;
    const send = claimed.record.send;
    if (send === undefined) throw new Error('A claimed draft carries its send');

    const progress = yield* vault
      .use((store, files) => driveSend(effectsOf(store, files), claimed))
      .pipe(
        // Past the claim, so perhaps past SMTP: nothing can say it did not go out.
        Effect.mapError(
          () =>
            new SendUnconfirmed({
              message: `The send of ${draftId} did not finish: ${UNCONFIRMED}`,
            }),
        ),
      );
    if (!progress.done && progress.reason === 'refused') {
      // The release moved the draft on, so sending it again names the version it is now.
      const released = yield* readDraft(draftId);
      const currentDraftId = draftIdOf(key, released.record.contentVersion);
      return yield* new SendRefused({
        address: record.from,
        currentDraftId,
        message: `${record.from}: ${describeMailFailure(progress.error, identity?.smtp.host ?? record.from)}. Nothing went out; the draft is back as ${currentDraftId}`,
      });
    }
    if (!progress.done && progress.reason !== 'copy-pending') {
      return yield* new SendUnconfirmed({
        message: `The draft ${draftId} was sent, but ${UNCONFIRMED}`,
      });
    }
    // The next list syncs the address first, and finds the Sent copy.
    const mailbox = mail.mailboxes.find(({ address }) => address === record.from);
    if (mailbox !== undefined) yield* cache.markStale(mailbox);
    yield* sent({
      messageId: send.messageId,
      isReplayed,
      sentCopy: (() => {
        if (!progress.done) return 'pending';
        return progress.sentCopy.ok ? 'stored' : 'none';
      })(),
    });
  }, reportFailure),
).pipe(
  Command.withShortDescription('Send exactly the draft version named'),
  Command.withDescription(`Send exactly the draft version named, from its From address's own mail server (SMTP), then keep a copy in its Sent folder. A draft changed since that draftId is a Conflict
naming its newest version (currentDraftId): read it, then send that.

Repeating it never sends twice. A send that went through answers "replayed": true, and one that
went out but did not finish (its Sent copy, say) is finished, never sent again. When nobody saw the
mail server's answer, it fails with SendUnconfirmed: the person checks Sent and settles it in
yozz.app. SendRefused means the server said no, or an attached file could not be read: nothing went
out, and the draft can be sent again.

"sentCopy": "pending" means it went out but the copy in Sent is not stored yet; sending the same
draftId again stores it. "none" means it went out and no copy was kept: the address's mailbox has no
Sent folder, or the person finished it without one in yozz.app, and sending again changes nothing.

Output:
  {
    "sent": true,
    "replayed": false,
    "messageId": "mid/<0b7a3c1e-…@fishball.ltd>",
    "threadId": "mid/<01J9XYZ@stripe.com>",
    "sentCopy": "stored",
    "url": "https://yozz.app/m/sent/t/mid%2F%3C01J9XYZ%40stripe.com%3E"
  }`),
  Command.withExamples([
    {
      command: "yozz send '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d@1'",
      description: 'Send it',
    },
  ]),
  Command.provide(MailboxLayer),
);
