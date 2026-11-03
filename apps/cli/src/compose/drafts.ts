import type { AddressRecord } from '@yozz.app/mail/addresses/record';
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
import { claimOf } from '@yozz.app/mail/compose/send';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { mimeTypeOf } from '@yozz.app/mail/threads/attachments';
import { draftIdOf as draftHandleOf } from '@yozz.app/mail/threads/thread';
import * as Effect from 'effect/Effect';
import {
  Conflict,
  DraftSending,
  NetworkError,
  NotFound,
  UsageError,
  VaultUnreadable,
} from '../errors.ts';
import { field, LINE_CHARS, NOTICE, untrusted } from '../mail/rows.ts';
import { Vault } from '../vault/vault.ts';

// What `draft`, `send` and `discard` share: reading a draft by its versioned id, printing it, and
// building the message it sends.

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
}: {
  readonly webUrl: string;
  readonly key: string;
  readonly record: DraftRecord;
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
      attachments: (record.attachments ?? []).map(attachment => ({
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

/**
 * The claim `send` writes: the composer's own (`claimOf`). Text too long for the record is said here,
 * so `draft` can refuse before anything is saved.
 */
export const claimFor = ({
  identity,
  key,
  record,
  now,
}: {
  readonly identity: AddressRecord;
  readonly key: string;
  readonly record: Parameters<typeof claimOf>[2];
  readonly now: number;
}) => {
  const claim = claimOf(identity, key, record, now);
  return claim.ok
    ? Effect.succeed(claim.value)
    : Effect.fail(new UsageError({ message: describeMailFailure(claim.error, identity.address) }));
};
