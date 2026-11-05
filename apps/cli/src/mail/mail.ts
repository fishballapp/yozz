import type { ImapSelected, ImapUntagged } from '@yozz.app/imap';
import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  type InboundAddress,
  isInbound,
  parseAddressRecord,
} from '@yozz.app/mail/addresses/record';
import {
  appendQuietLimitMs,
  type MailClient,
  type MailConnectionFailure,
  type MailTask,
  type Result,
  type RunTask,
} from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import type { TxtLookup } from '@yozz.app/mail/threads/dkim';
import * as Console from 'effect/Console';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Semaphore from 'effect/Semaphore';
import { usingCache } from '../cache/disk.ts';
import { MailServerError, reportFailure, type UsageError } from '../errors.ts';
import { Vault } from '../vault/vault.ts';
import { connectImap, connectSmtp, MailServers, QUIET_LIMIT_MS } from './servers.ts';

/** How often a server without IDLE is asked again while `list --wait` waits. */
const POLL_SECONDS = 30;

/** What a server says while idling that means the inbox changed. */
const CHANGES = new Set<ImapUntagged['kind']>(['exists', 'expunge', 'fetch']);

/** A connection that failed like this is gone, or never was; one that answered NO or BAD is still good. */
const isBroken = (failure: MailConnectionFailure) =>
  failure.kind === 'tls' ||
  failure.kind === 'stalled' ||
  (failure.kind === 'imap' && ['closed', 'bye', 'protocol'].includes(failure.reason.kind));

/** A failed connection or command, naming the address and saying what happened in one sentence. */
export const mailServerError = (
  { address, host }: { readonly address: string; readonly host: string },
  failure: MailConnectionFailure,
) => new MailServerError({ address, message: `${address}: ${describeMailFailure(failure, host)}` });

type Session = {
  readonly client: MailClient;
  readonly setQuietLimit: (ms: number) => void;
  readonly close: () => Promise<void>;
  /** Hears untagged responses while the inbox idles. */
  onChange: (() => void) | null;
};

export class Mail extends Context.Service<
  Mail,
  {
    /** Every address the vault holds, in address order. */
    readonly identities: readonly AddressRecord[];
    /** The addresses mail is read for. */
    readonly mailboxes: readonly InboundAddress[];
    /** `@yozz.app/mail`'s port: the mailbox's one connection, opened by its first task. */
    readonly runOn: (mailbox: InboundAddress) => RunTask;
    /** The DNS side of a sender check. */
    readonly lookupTxt: TxtLookup;
    /** Runs `f` on the mailbox's connection; a failure names the address. */
    readonly use: <A>(
      mailbox: InboundAddress,
      f: (run: RunTask) => Promise<Result<A, MailConnectionFailure>>,
    ) => Effect.Effect<A, MailServerError | UsageError>;
    /**
     * Holds the mailbox's INBOX in IDLE until the server says it changed. Returns at once when its
     * next uid is past `lastUid`, and after a while on a server without IDLE.
     */
    readonly waitForInbox: (
      mailbox: InboundAddress,
      lastUid: number,
    ) => Effect.Effect<void, MailServerError>;
    /**
     * One SMTP connection, one submission of exactly these bytes, as the web app's `submitBytes`. A
     * failure says which side of the end of `DATA` it fell on (`isUnconfirmedSubmission`), which the
     * send machine needs to know. A promise, as `@yozz.app/mail`'s `SendEffects` takes it.
     */
    readonly submit: (
      identity: AddressRecord,
      bytes: Uint8Array,
      recipients: readonly string[],
    ) => Promise<Result<void, MailConnectionFailure>>;
  }
>()('@yozz.app/cli/Mail') {
  /** One connection per inbound address, opened on first use and closed when the command ends. */
  static readonly layer = Layer.effect(
    Mail,
    reportFailure(
      Effect.gen(function* () {
        const servers = yield* MailServers;
        const { use: useVault } = yield* Vault;
        const rows = yield* useVault(store => store.list(ADDRESS_RECORD_TYPE));
        const identities = rows
          .map(({ plaintext }) => parseAddressRecord(plaintext))
          .filter((record): record is AddressRecord => record !== null)
          .toSorted((a, b) => a.address.localeCompare(b.address));
        if (identities.length < rows.length) {
          yield* Console.error(
            `Skipped ${rows.length - identities.length} address record(s) this version of yozz cannot read.`,
          );
        }

        const failure = (address: string, host: string, cause: MailConnectionFailure) =>
          new MailServerError({
            address,
            message: `${address}: ${describeMailFailure(cause, host)}`,
          });

        const sessions = new Map<string, Promise<Result<Session, MailConnectionFailure>>>();
        const open = async (mailbox: InboundAddress) => {
          const session: { current: Session | null } = { current: null };
          const selected: { name: string | null; info: ImapSelected | null } = {
            name: null,
            info: null,
          };
          const connected = await connectImap(servers, mailbox.imap, {
            onUntagged: untagged => {
              if (CHANGES.has(untagged.kind)) session.current?.onChange?.();
            },
          });
          if (!connected.ok) return connected;
          const { client, setQuietLimit, close } = connected.value;
          const select: MailClient['select'] = async folderName => {
            // Read-write: flag writes and moves need it.
            const res = await client.select(folderName, { readOnly: false });
            selected.name = res.ok ? folderName : null;
            selected.info = res.ok ? res.value : null;
            return res;
          };
          session.current = {
            client: {
              ...client,
              select,
              append: async (folderName, message, flags, internalDate) => {
                setQuietLimit(appendQuietLimitMs(message.length));
                try {
                  return await client.append(folderName, message, flags, internalDate);
                } finally {
                  setQuietLimit(QUIET_LIMIT_MS);
                }
              },
              ensureSelected: async name =>
                selected.name === name && selected.info !== null
                  ? { ok: true, value: selected.info }
                  : select(name),
            },
            setQuietLimit,
            close,
            onChange: null,
          };
          return { ok: true as const, value: session.current };
        };
        const sessionOf = (mailbox: InboundAddress) => {
          const existing = sessions.get(mailbox.address);
          if (existing !== undefined) return existing;
          const opening = open(mailbox);
          sessions.set(mailbox.address, opening);
          return opening;
        };
        const drop = async (mailbox: InboundAddress) => {
          const session = await sessions.get(mailbox.address);
          sessions.delete(mailbox.address);
          if (session?.ok) await session.value.close();
        };
        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            Promise.all(
              [...sessions.values()].map(async opening => {
                const session = await opening;
                if (session.ok) await session.value.close();
              }),
            ),
          ),
        );

        // One task at a time per mailbox: a task selects a folder and relies on it staying selected.
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const locks = new Map(
          identities.filter(isInbound).map(({ address }) => [address, Semaphore.makeUnsafe(1)]),
        );
        const runOn =
          (mailbox: InboundAddress): RunTask =>
          <T>(task: MailTask<T>) => {
            const lock = locks.get(mailbox.address);
            if (lock === undefined) throw new Error(`${mailbox.address} is not an inbound address`);
            const attempt = async (): Promise<Result<T, MailConnectionFailure>> => {
              // It waited its turn for nothing: nobody wants the answer, and no command goes out.
              if (task.signal?.aborted === true) return { ok: false, error: { kind: 'cancelled' } };
              const session = await sessionOf(mailbox);
              if (!session.ok) {
                sessions.delete(mailbox.address);
                return session;
              }
              const res = await task.run(session.value.client);
              // The next task opens a fresh connection rather than writing into a dead one.
              if (!res.ok && isBroken(res.error)) await drop(mailbox);
              return res;
            };
            return runPromise(
              Effect.promise(async () => {
                const res = await attempt();
                // As the web app does: a task that may be run twice gets one more go on a fresh
                // connection when the first was lost, or could not be made.
                return !res.ok && task.retry && isBroken(res.error) ? attempt() : res;
              }).pipe(lock.withPermits(1)),
            );
          };

        const use = <A>(
          mailbox: InboundAddress,
          f: (run: RunTask) => Promise<Result<A, MailConnectionFailure>>,
        ) =>
          usingCache(() => f(runOn(mailbox))).pipe(
            Effect.flatMap(res =>
              res.ok
                ? Effect.succeed(res.value)
                : Effect.fail(failure(mailbox.address, mailbox.imap.host, res.error)),
            ),
          );

        /** IDLE until the inbox changes or `signal` aborts; `false` from a server without IDLE. */
        const idleTask = (
          mailbox: InboundAddress,
          lastUid: number,
          signal: AbortSignal,
        ): MailTask<boolean> => ({
          priority: 'user',
          effect: 'read',
          retry: false,
          run: async client => {
            const inbox = await client.ensureSelected('INBOX');
            if (!inbox.ok) return { ok: false, error: { kind: 'imap', reason: inbox.reason } };
            // The wait ended while the inbox was being selected: there is nothing to idle for.
            if (signal.aborted) return { ok: true, value: true };
            if (inbox.value.uidNext !== null && inbox.value.uidNext > lastUid + 1) {
              return { ok: true, value: true };
            }
            if (!client.hasCapability('IDLE')) return { ok: true, value: false };
            const session = await sessionOf(mailbox);
            if (!session.ok) return session;
            const changed = Promise.withResolvers<null>();
            session.value.onChange = () => changed.resolve(null);
            signal.addEventListener('abort', () => changed.resolve(null), { once: true });
            // A quiet inbox is the point now; the limit comes back before DONE, which it bounds.
            session.value.setQuietLimit(0);
            const idle = client.idle();
            const ended = await Promise.race([changed.promise, idle.ended]);
            session.value.onChange = null;
            session.value.setQuietLimit(QUIET_LIMIT_MS);
            const done = await idle.done();
            const outcome = ended ?? done;
            return outcome.ok
              ? { ok: true, value: true }
              : { ok: false, error: { kind: 'imap', reason: outcome.reason } };
          },
        });

        return Mail.of({
          identities,
          mailboxes: identities.filter(isInbound),
          runOn,
          lookupTxt: servers.lookupTxt,
          use,
          waitForInbox: Effect.fn('Mail.waitForInbox')(function* (mailbox, lastUid) {
            const hasIdle = yield* Effect.tryPromise(signal =>
              runOn(mailbox)(idleTask(mailbox, lastUid, signal)),
            ).pipe(
              Effect.orDie,
              Effect.flatMap(res =>
                res.ok
                  ? Effect.succeed(res.value)
                  : Effect.fail(failure(mailbox.address, mailbox.imap.host, res.error)),
              ),
            );
            if (!hasIdle) yield* Effect.sleep(`${POLL_SECONDS} seconds`);
          }),
          submit: async (identity, bytes, recipients) => {
            const connected = await connectSmtp(servers, identity.smtp);
            if (!connected.ok) return connected;
            const { client, close } = connected.value;
            const sent = await client.send({ from: identity.address, to: recipients, data: bytes });
            await close();
            return sent.ok
              ? { ok: true, value: undefined }
              : { ok: false, error: { kind: 'smtp', reason: sent.reason } };
          },
        });
      }),
    ),
  );
}
