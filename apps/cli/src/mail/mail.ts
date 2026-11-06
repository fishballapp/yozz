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
  SEARCH_QUIET_LIMIT_MS,
  SUMMARIES_QUIET_LIMIT_MS,
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
    /**
     * `@yozz.app/mail`'s port: the mailbox's one connection, opened by its first task. Once
     * `signal` aborts, a task neither opens a connection nor runs again on a fresh one.
     */
    readonly runOn: (mailbox: InboundAddress, signal?: AbortSignal) => RunTask;
    /** The DNS side of a sender check. */
    readonly lookupTxt: TxtLookup;
    /** Runs `f` on the mailbox's connection; a failure names the address. */
    readonly use: <A>(
      mailbox: InboundAddress,
      f: (run: RunTask) => Promise<Result<A, MailConnectionFailure>>,
    ) => Effect.Effect<A, MailServerError | UsageError>;
    /**
     * Holds the mailbox's INBOX in IDLE until the server says it changed, and waits a while on a
     * server without IDLE. INBOX stays selected from the look before, so this sends no SELECT.
     */
    readonly idleInbox: (mailbox: InboundAddress) => Effect.Effect<void, MailServerError>;
    /** Ends the mailbox's connection now, opening or open, with no LOGOUT: nobody waits for it. */
    readonly abandon: (mailbox: InboundAddress) => Effect.Effect<void>;
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
        /** What ends each mailbox's current connection, however far it has got. */
        const enders = new Map<string, AbortController>();
        const open = async (mailbox: InboundAddress) => {
          const ender = new AbortController();
          enders.set(mailbox.address, ender);
          const session: { current: Session | null } = { current: null };
          const selected: { name: string | null; info: ImapSelected | null } = {
            name: null,
            info: null,
          };
          const connected = await connectImap(servers, mailbox.imap, {
            onUntagged: untagged => {
              if (CHANGES.has(untagged.kind)) session.current?.onChange?.();
            },
            signal: ender.signal,
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
          /** A command whose server may go quiet for longer than `QUIET_LIMIT_MS`, given `ms` instead. */
          const quietFor = async <T>(ms: number, command: () => Promise<T>): Promise<T> => {
            setQuietLimit(ms);
            try {
              return await command();
            } finally {
              setQuietLimit(QUIET_LIMIT_MS);
            }
          };
          session.current = {
            client: {
              ...client,
              select,
              append: (folderName, message, flags, internalDate) =>
                quietFor(appendQuietLimitMs(message.length), () =>
                  client.append(folderName, message, flags, internalDate),
                ),
              uidSearch: criterion =>
                quietFor(SEARCH_QUIET_LIMIT_MS, () => client.uidSearch(criterion)),
              fetchSummaries: uidSet =>
                quietFor(SUMMARIES_QUIET_LIMIT_MS, () => client.fetchSummaries(uidSet)),
              fetchSummariesBySeq: seqSet =>
                quietFor(SUMMARIES_QUIET_LIMIT_MS, () => client.fetchSummariesBySeq(seqSet)),
              fetchAttachmentNames: uidSet =>
                quietFor(SUMMARIES_QUIET_LIMIT_MS, () => client.fetchAttachmentNames(uidSet)),
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
        /** Ends the mailbox's connection at once: whatever it is running, nobody waits for now. */
        const abandon = (mailbox: InboundAddress) => {
          // Forgotten first, so neither the next task nor the finalizer waits on it.
          sessions.delete(mailbox.address);
          enders.get(mailbox.address)?.abort();
          enders.delete(mailbox.address);
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
          (mailbox: InboundAddress, signal?: AbortSignal): RunTask =>
          <T>(task: MailTask<T>) => {
            const lock = locks.get(mailbox.address);
            if (lock === undefined) throw new Error(`${mailbox.address} is not an inbound address`);
            const cancelled = AbortSignal.any(
              [task.signal, signal].filter(candidate => candidate !== undefined),
            );
            const attempt = async (): Promise<Result<T, MailConnectionFailure>> => {
              // Nobody wants the answer: no connection is opened, and no command goes out.
              if (cancelled.aborted) return { ok: false, error: { kind: 'cancelled' } };
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
          usingCache(signal => {
            // Interrupted (a wait's deadline, Ctrl-C), the command on the wire may run for minutes,
            // and a LOGOUT would queue behind it; nor is it run again on a fresh connection.
            signal.addEventListener('abort', () => abandon(mailbox), { once: true });
            return f(runOn(mailbox, signal));
          }).pipe(
            Effect.flatMap(res =>
              res.ok
                ? Effect.succeed(res.value)
                : Effect.fail(failure(mailbox.address, mailbox.imap.host, res.error)),
            ),
          );

        /** IDLE until the inbox changes or `signal` aborts; `false` from a server without IDLE. */
        const idleTask = (mailbox: InboundAddress, signal: AbortSignal): MailTask<boolean> => ({
          priority: 'user',
          effect: 'read',
          retry: false,
          run: async client => {
            const inbox = await client.ensureSelected('INBOX');
            if (!inbox.ok) return { ok: false, error: { kind: 'imap', reason: inbox.reason } };
            // The wait ended while the inbox was being selected: there is nothing to idle for.
            if (signal.aborted) return { ok: true, value: true };
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
          abandon: mailbox => Effect.sync(() => abandon(mailbox)),
          idleInbox: Effect.fn('Mail.idleInbox')(function* (mailbox) {
            const hasIdle = yield* Effect.tryPromise(signal =>
              runOn(mailbox, signal)(idleTask(mailbox, signal)),
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
