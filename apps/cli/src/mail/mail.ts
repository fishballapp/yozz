import type { ImapSelected, ImapUntagged } from '@yozz.app/imap';
import {
  ADDRESS_RECORD_TYPE,
  type AddressRecord,
  type InboundAddress,
  isInbound,
  parseAddressRecord,
} from '@yozz.app/mail/addresses/record';
import type {
  MailClient,
  MailConnectionFailure,
  MailTask,
  Result,
  RunTask,
} from '@yozz.app/mail/connection';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import * as Console from 'effect/Console';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as Scope from 'effect/Scope';
import * as Semaphore from 'effect/Semaphore';
import { usingCache } from '../cache/disk.ts';
import { MailServerError, reportFailure, type UsageError } from '../errors.ts';
import { Vault } from '../vault/vault.ts';
import {
  connectImap,
  connectSmtp,
  MailServers,
  QUIET_LIMIT_MS,
  type SmtpConnection,
} from './servers.ts';

/** How often a server without IDLE is asked again while `list --wait` waits. */
const POLL_SECONDS = 30;

/** What a server says while idling that means the inbox changed. */
const CHANGES = new Set<ImapUntagged['kind']>(['exists', 'expunge', 'fetch']);

/** A connection that failed like this is gone; one that answered NO or BAD is still good. */
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
    readonly accounts: readonly InboundAddress[];
    /** `@yozz.app/mail`'s port: the account's one connection, opened by its first task. */
    readonly runOn: (account: InboundAddress) => RunTask;
    /** Runs `f` on the account's connection; a failure names the address. */
    readonly use: <A>(
      account: InboundAddress,
      f: (run: RunTask) => Promise<Result<A, MailConnectionFailure>>,
    ) => Effect.Effect<A, MailServerError | UsageError>;
    /**
     * Holds the account's INBOX in IDLE until the server says it changed. Returns at once when its
     * next uid is past `lastUid`, and after a while on a server without IDLE.
     */
    readonly waitForInbox: (
      account: InboundAddress,
      lastUid: number,
    ) => Effect.Effect<void, MailServerError>;
    /** A signed-in SMTP connection for the address, closed with the scope. */
    readonly smtp: (
      identity: AddressRecord,
    ) => Effect.Effect<SmtpConnection, MailServerError, Scope.Scope>;
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
        const open = async (account: InboundAddress) => {
          const session: { current: Session | null } = { current: null };
          const selected: { name: string | null; info: ImapSelected | null } = {
            name: null,
            info: null,
          };
          const connected = await connectImap(servers, account.imap, {
            onUntagged: untagged => {
              if (CHANGES.has(untagged.kind)) session.current?.onChange?.();
            },
          });
          if (!connected.ok) return connected;
          const { client, setQuietLimit, close } = connected.value;
          const select: MailClient['select'] = async mailbox => {
            // Read-write: flag writes and moves need it.
            const res = await client.select(mailbox, { readOnly: false });
            selected.name = res.ok ? mailbox : null;
            selected.info = res.ok ? res.value : null;
            return res;
          };
          session.current = {
            client: {
              ...client,
              select,
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
        const sessionOf = (account: InboundAddress) => {
          const existing = sessions.get(account.address);
          if (existing !== undefined) return existing;
          const opening = open(account);
          sessions.set(account.address, opening);
          return opening;
        };
        const drop = async (account: InboundAddress) => {
          const session = await sessions.get(account.address);
          sessions.delete(account.address);
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

        // One task at a time per account: a task selects a mailbox and relies on it staying selected.
        const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
        const locks = new Map(
          identities.filter(isInbound).map(({ address }) => [address, Semaphore.makeUnsafe(1)]),
        );
        const runOn =
          (account: InboundAddress): RunTask =>
          <T>(task: MailTask<T>) => {
            const lock = locks.get(account.address);
            if (lock === undefined) throw new Error(`${account.address} is not an inbound address`);
            return runPromise(
              Effect.promise(async (): Promise<Result<T, MailConnectionFailure>> => {
                const session = await sessionOf(account);
                if (!session.ok) {
                  sessions.delete(account.address);
                  return session;
                }
                const res = await task.run(session.value.client);
                // The next task opens a fresh connection rather than writing into a dead one.
                if (!res.ok && isBroken(res.error)) await drop(account);
                return res;
              }).pipe(lock.withPermits(1)),
            );
          };

        const use = <A>(
          account: InboundAddress,
          f: (run: RunTask) => Promise<Result<A, MailConnectionFailure>>,
        ) =>
          usingCache(() => f(runOn(account))).pipe(
            Effect.flatMap(res =>
              res.ok
                ? Effect.succeed(res.value)
                : Effect.fail(failure(account.address, account.imap.host, res.error)),
            ),
          );

        /** IDLE until the inbox changes or `signal` aborts; `false` from a server without IDLE. */
        const idleTask = (
          account: InboundAddress,
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
            const session = await sessionOf(account);
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
          accounts: identities.filter(isInbound),
          runOn,
          use,
          waitForInbox: Effect.fn('Mail.waitForInbox')(function* (account, lastUid) {
            const hasIdle = yield* Effect.tryPromise(signal =>
              runOn(account)(idleTask(account, lastUid, signal)),
            ).pipe(
              Effect.orDie,
              Effect.flatMap(res =>
                res.ok
                  ? Effect.succeed(res.value)
                  : Effect.fail(failure(account.address, account.imap.host, res.error)),
              ),
            );
            if (!hasIdle) yield* Effect.sleep(`${POLL_SECONDS} seconds`);
          }),
          smtp: identity =>
            Effect.acquireRelease(
              Effect.promise(() => connectSmtp(servers, identity.smtp)).pipe(
                Effect.flatMap(res =>
                  res.ok
                    ? Effect.succeed(res.value)
                    : Effect.fail(failure(identity.address, identity.smtp.host, res.error)),
                ),
              ),
              connection => Effect.promise(() => connection.close()),
            ),
        });
      }),
    ),
  );
}
