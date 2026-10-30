import { type AddressRecord, isInbound } from '@yozz.app/mail/addresses/record';
import { BODY_CHARS, clip } from '@yozz.app/mail/agent-budgets';
import { addressList } from '@yozz.app/mail/compose/draft';
import {
  DRAFT_RECORD_TYPE,
  type DraftRecord,
  draftIdOf,
  parseDraftId,
  parseDraftRecord,
} from '@yozz.app/mail/compose/draft-record';
import type { SaveOutcome } from '@yozz.app/mail/compose/draft-vault';
import { buildOutgoing } from '@yozz.app/mail/compose/send';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { type Attachment, draftIdOf as draftHandleOf } from '@yozz.app/mail/threads/thread';
import { MAX_CIPHERTEXT_BYTES } from '@yozz.app/vault-contract';
import * as Effect from 'effect/Effect';
import {
  Conflict,
  DraftSending,
  NetworkError,
  NotFound,
  UsageError,
  VaultUnreadable,
} from '../errors.ts';
import { field, LINE_CHARS, mimeTypeOf, NOTICE, untrusted } from '../mail/rows.ts';
import { Vault } from '../vault/vault.ts';

// What `draft`, `send` and `discard` share: reading a draft by its versioned id, printing it, and
// building the message it sends.

type Send = NonNullable<DraftRecord['send']>;

/** The draft a versioned id names, at whatever version it is now; `NotFound` when there is none. */
export const readDraft = Effect.fn('compose.readDraft')(function* (draftId: string) {
  const parsed = parseDraftId(draftId);
  if (parsed === null) {
    return yield* new UsageError({
      message: `${draftId} is not a draftId: it is <key>@<version>, as yozz draft prints it`,
    });
  }
  const opened = yield* (yield* Vault).use(store => store.get(DRAFT_RECORD_TYPE, parsed.key));
  if (opened === null) return yield* new NotFound({ message: `There is no draft ${draftId}` });
  const record = parseDraftRecord(opened.plaintext);
  if (record === null) {
    return yield* new VaultUnreadable({
      message: `The draft ${draftId} is in a shape this version of yozz can't read`,
    });
  }
  return { key: parsed.key, version: parsed.version, record };
});

/** Why a tombstoned draft can't be used: it went out, or it was thrown away. */
export const goneDraft = (draftId: string, record: DraftRecord) =>
  new NotFound({
    message:
      record.sentMessageId === undefined
        ? `The draft ${draftId} was discarded`
        : `The draft ${draftId} was sent already`,
  });

/** A refused draft write, as the error the CLI prints. */
export const refusedSave = (
  draftId: string,
  outcome: Exclude<SaveOutcome, { readonly ok: true }>,
) => {
  if (outcome.reason === 'sending') {
    return new DraftSending({
      message: `The draft ${draftId} is being sent, or waits for you to settle a send in yozz.app`,
    });
  }
  if (outcome.reason === 'offline') {
    return new NetworkError({ message: 'The draft could not be saved: YOZZ could not be reached' });
  }
  if (outcome.currentDraftId === null) {
    return new NotFound({ message: `There is no draft ${draftId}` });
  }
  return conflictOf(draftId, outcome.currentDraftId);
};

/** A draft that moved on since `draftId`, naming its newest version and how to read it. */
export const conflictOf = (draftId: string, currentDraftId: string) =>
  new Conflict({
    message: `The draft changed since ${draftId}: its newest version is ${currentDraftId}. Read it with yozz read '${currentDraftId}' before sending`,
    currentDraftId,
  });

/** Where `seedFor`'s quote begins: the line `quoteForReply` opens it with. */
const QUOTE_START = /\n\nOn [^\n]* wrote:\n/u;

/** The body as written above the quote, and the quote of the mail answered or passed on. */
export const splitQuote = (body: string) => {
  const at = body.search(QUOTE_START);
  return at === -1 ? { text: body, quote: '' } : { text: body.slice(0, at), quote: body.slice(at) };
};

/** The address to send as, when it is one of the account's. */
export const identityOf = (identities: readonly AddressRecord[], address: string) => {
  const identity = identities.find(candidate => candidate.address === address);
  return identity === undefined
    ? Effect.fail(
        new UsageError({
          message: `${address} is not one of your addresses; yozz whoami lists them`,
        }),
      )
    : Effect.succeed(identity);
};

/**
 * The draft whole, as `draft` prints it: exactly what `send` sends. What may have come from mail
 * (the subject a reply takes, the quote, a forward's attachment names) sits under `untrusted`.
 */
export const draftJson = ({
  webUrl,
  key,
  record,
  attachments,
}: {
  readonly webUrl: string;
  readonly key: string;
  readonly record: DraftRecord;
  readonly attachments: readonly Attachment[];
}) => {
  const { text, quote } = splitQuote(record.body);
  const addresses = (value: string) => addressList(value).map(untrusted);
  return {
    notice: NOTICE,
    draft: {
      id: draftHandleOf(key),
      draftId: draftIdOf(key, record.contentVersion),
      url: `${webUrl}/m/drafts?compose=${encodeURIComponent(`draft:${key}`)}`,
      from: record.from,
      to: addresses(record.to),
      cc: addresses(record.cc),
      bcc: addresses(record.bcc),
      text: untrusted(text),
      attachments: attachments.map(attachment => ({
        type: mimeTypeOf(attachment.mimeType),
        size: attachment.size,
        untrusted: { name: field(attachment.name, LINE_CHARS) },
      })),
      ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
      ...(record.inReplyTo === undefined ? {} : { inReplyTo: `mid/${record.inReplyTo}` }),
      untrusted: {
        subject: field(record.subject, LINE_CHARS),
        ...(quote === '' ? {} : { quote: untrusted(clip(quote, BODY_CHARS)) }),
      },
    },
  };
};

/** A fresh Message-ID on the sending address's own domain, as the composer mints it. */
export const newMessageId = (from: string) =>
  `<${crypto.randomUUID()}@${from.slice(from.indexOf('@') + 1)}>`;

/**
 * The claim `send` writes: the message's exact bytes, built once by the composer's own
 * `buildOutgoing` (markdown with its rendered HTML), and where its Sent copy goes. The claim keeps
 * the bytes in the draft's vault record, so a message too big for one record can't be sent; that is
 * said here, before anything is written, rather than as a failed claim.
 */
export const claimOf = Effect.fn('compose.claimOf')(function* ({
  identity,
  key,
  record,
  attachments,
  now,
}: {
  readonly identity: AddressRecord;
  readonly key: string;
  readonly record: DraftRecord;
  readonly attachments: readonly Attachment[];
  readonly now: number;
}) {
  const messageId = newMessageId(record.from);
  const built = buildOutgoing(identity, {
    to: addressList(record.to),
    cc: addressList(record.cc),
    bcc: addressList(record.bcc),
    subject: record.subject,
    text: record.body,
    messageId,
    ...(record.inReplyTo === undefined ? {} : { inReplyTo: record.inReplyTo }),
    ...(record.references === undefined ? {} : { references: record.references }),
    attachments,
  });
  if (!built.ok) {
    return yield* new UsageError({ message: describeMailFailure(built.error, identity.address) });
  }
  const send: Send = {
    messageId,
    opId: crypto.randomUUID(),
    state: 'submitting',
    claimedAt: now,
    bytes: built.value.toBase64(),
    // The logical folder; the name is resolved against LIST at copy time.
    target: isInbound(identity) ? { account: identity.address, folder: 'sent' } : 'vault',
  };
  const plaintext = JSON.stringify({ ...record, contentVersion: record.contentVersion + 1, send });
  // `@yozz.app/vault`'s record: base64 of iv ‖ AES-GCM(tag) over the JSON of revision, key, plaintext.
  const sealedBytes =
    12 +
    16 +
    new TextEncoder().encode(JSON.stringify([String(Number.MAX_SAFE_INTEGER), key, plaintext]))
      .length;
  if (Math.ceil(sealedBytes / 3) * 4 > MAX_CIPHERTEXT_BYTES) {
    return yield* new UsageError({
      message: `This message is ${Math.round(built.value.length / 1024)} KB, too big to send: a send keeps the message in the draft's vault record, which holds at most 1 MB. Send smaller attachments`,
    });
  }
  return send;
});
