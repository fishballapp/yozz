import type {
  ImapClient,
  ImapIdle,
  ImapMailbox,
  ImapResult,
  ImapSelected,
  ImapUntagged,
} from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import {
  appendQuietLimitMs,
  type MailClient,
  type MailConnectionFailure,
  type MailTask,
  type Result,
  type RunTask,
} from '@yozz.app/mail/connection';
import type { ActivityTracker } from './activity';
import type { MailConnection } from './connection';

/**
 * Opened by the first task and kept open, hidden tab or not, holding `INBOX` in IDLE whenever
 * nothing is queued so the server can say "new mail" instead of being asked. Every IMAP touch is a
 * task on this queue; Connect's pre-store test is the one exception.
 */

export type LiveState =
  /** Nothing open: never opened, or closed by us (lock, address removed). */
  | { readonly status: 'closed' }
  | { readonly status: 'connecting' }
  | { readonly status: 'live'; readonly resumed: boolean; readonly idling: boolean }
  | { readonly status: 'reconnecting' }
  /** The server or the network ended it; the next task, or a visibility/online event, retries. */
  | { readonly status: 'failed'; readonly failure: MailConnectionFailure; readonly at: number };

/** `LiveManager.run` for one mailbox, as the mail store hands it out. */
export type RunOn = (mailbox: InboundAddress) => RunTask;

export type LiveManager = {
  readonly run: <T>(
    mailbox: InboundAddress,
    task: MailTask<T>,
  ) => Promise<Result<T, MailConnectionFailure>>;
  readonly close: (address: string) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly state: (address: string) => LiveState;
};

type ConnectFn = (
  imap: InboundAddress['imap'],
  options?: {
    readonly onUntagged?: (response: ImapUntagged) => void;
    readonly onTraffic?: () => void;
    readonly signal?: AbortSignal;
  },
) => Promise<Result<MailConnection, MailConnectionFailure>>;

type Queued = {
  readonly task: MailTask<unknown>;
  readonly resolve: (result: Result<unknown, MailConnectionFailure>) => void;
};

/** An open, authenticated connection. Replaced whole on reconnect, never mutated back to life. */
type Socket = {
  readonly client: MailClient;
  readonly close: () => Promise<void>;
  readonly resumed: boolean;
  idle: ImapIdle | null;
  selected: string | null;
  /** What the last SELECT answered, so a write can check the folder has not been renumbered. */
  selectedInfo: ImapSelected | null;
  /** The selected folder's size as the server last stated it, so an EXISTS can say it grew. */
  exists: number;
  /** SELECTs sent so far: only the latest one's answer says which folder the socket is in. */
  selects: number;
};

type Connection = {
  readonly address: string;
  imap: InboundAddress['imap'];
  imapKey: string;
  socket: Socket | null;
  /** The credentials `socket` was opened with; a task never starts on a socket whose key moved. */
  socketKey: string | null;
  /** The last socket's shutdown; a new one is opened only after it settles. */
  teardown: Promise<void>;
  state: LiveState;
  userQueue: Queued[];
  backgroundQueue: Queued[];
  /** The running drain of the queues, or null when nothing is running. */
  pumping: Promise<void> | null;
  /** The one keepalive timer: an IDLE refresh, or the minute tick of the no-IDLE fallback. */
  keepalive: ReturnType<typeof setTimeout> | null;
  tickMinutes: number;
  changedAt: number | null;
  /**
   * INBOX as the caller last read it, by a fresh SELECT (a sync), or null once told it changed, until
   * that sync reads it again. What a SELECT for other work finds is compared with it.
   */
  inboxRead: ImapSelected | null;
  idleDroppedAt: number | null;
  /**
   * What `LIST` answered this session, by reference and pattern: folders are seldom made or renamed,
   * and a LIST can take seconds. Forgotten when the login changes, when we create a folder, and
   * when a SELECT, MOVE or APPEND is refused, as one naming a folder gone since would be.
   */
  listed: Map<string, readonly ImapMailbox[]>;
  /** When work here last moved: bytes either way, a task starting or ending, or work arriving. */
  progressAt: number;
  /** How long that may last before the work has stalled: `STALL_MS`, or what the running APPEND allows. */
  stallAfterMs: number;
  /** Ends the socket being opened or open at once, without the LOGOUT a stalled command would hold up. */
  abort: AbortController | null;
};

const imapKeyOf = (imap: InboundAddress['imap']): string =>
  `${imap.host}|${imap.port}|${imap.username}|${imap.password}`;

const isTransportFailure = (error: MailConnectionFailure): boolean =>
  error.kind === 'imap' &&
  (error.reason.kind === 'closed' ||
    error.reason.kind === 'bye' ||
    error.reason.kind === 'protocol');

const CLOSED: LiveState = { status: 'closed' };
const CONNECTION_CLOSED: MailConnectionFailure = { kind: 'error', detail: 'connection closed' };
const STALLED: MailConnectionFailure = { kind: 'stalled' };
const CANCELLED: MailConnectionFailure = { kind: 'cancelled' };

/** RFC 2177 §3: a server may drop an IDLE after 30 minutes; re-issue well inside that. */
const IDLE_REFRESH_MS = 25 * 60 * 1000;
const TICK_MS = 60 * 1000;
const NOOP_EVERY_MINUTES = 5;
/** Without IDLE, polling is the honest fallback for noticing new mail. */
const POLL_EVERY_MINUTES = 2;
const MAILBOX_CHANGE_THROTTLE_MS = 1000;
/** A dropped IDLE is reopened at once, but a server dropping every reopen is not retried in a loop. */
const IDLE_RECONNECT_MIN_GAP_MS = 60 * 1000;
/**
 * Work waiting this long with nothing moving has stalled. Measured as no progress, not as a task's
 * age: an APPEND of a large message takes minutes to upload, and has `appendQuietLimitMs` for the
 * silence after it.
 */
const STALL_MS = 60 * 1000;
const STALL_CHECK_MS = 10 * 1000;

export const createLiveManager = (deps: {
  readonly connect: ConnectFn;
  /** Each connection's state as it changes; for tests and diagnostics, nothing on screen reads it. */
  readonly onState?: (address: string, state: LiveState) => void;
  /** INBOX changed since the caller last read it, or may have (the no-IDLE poll): the caller syncs. */
  readonly onMailboxChanged: (address: string) => void;
  /** Told of every task from the moment it is queued until it settles. */
  readonly activity?: ActivityTracker;
  readonly now?: () => number;
  readonly setTimer?: typeof setTimeout;
  readonly clearTimer?: typeof clearTimeout;
}): LiveManager => {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  const connections = new Map<string, Connection>();

  const setState = (conn: Connection, state: LiveState): void => {
    conn.state = state;
    deps.onState?.(conn.address, state);
  };

  const setFailed = (conn: Connection, failure: MailConnectionFailure): void =>
    setState(conn, { status: 'failed', failure, at: now() });

  const clearKeepalive = (conn: Connection): void => {
    if (conn.keepalive === null) return;
    clearTimer(conn.keepalive);
    conn.keepalive = null;
  };

  const rejectQueued = (conn: Connection, error: MailConnectionFailure): void => {
    const pending = [...conn.userQueue, ...conn.backgroundQueue];
    conn.userQueue = [];
    conn.backgroundQueue = [];
    for (const item of pending) item.resolve({ ok: false, error });
  };

  /** A burst of changes is one sync, and the sync it asks for reads INBOX afresh. */
  const reportChange = (conn: Connection): void => {
    conn.inboxRead = null;
    const at = now();
    if (conn.changedAt !== null && at - conn.changedAt < MAILBOX_CHANGE_THROTTLE_MS) return;
    conn.changedAt = at;
    deps.onMailboxChanged(conn.address);
  };

  /**
   * Only an unsolicited response is "the mailbox changed": a SELECT's EXISTS and a FETCH's FETCH are
   * the command's answer. While idling, any change to INBOX counts; while a command runs there, only
   * INBOX growing does, since our own commands flag and remove its messages but never add one.
   */
  const handleUntagged = (conn: Connection, untagged: ImapUntagged): void => {
    const socket = conn.socket;
    if (socket === null) return;
    const hasGrown = untagged.kind === 'exists' && untagged.count > socket.exists;
    if (untagged.kind === 'exists') socket.exists = untagged.count;
    if (untagged.kind === 'expunge') socket.exists -= 1;
    // Mid-SELECT nothing is selected, and its EXISTS is the folder's size, not news.
    if (socket.selected !== 'INBOX') return;
    const isChange =
      socket.idle === null
        ? hasGrown
        : untagged.kind === 'exists' || untagged.kind === 'expunge' || untagged.kind === 'fetch';
    if (isChange) reportChange(conn);
  };

  /**
   * A SELECT of INBOX for other work (a body, a flag, going back to IDLE) finding mail the caller has
   * not read: it arrived while another folder was selected, and the server tells only the selected one.
   */
  const noticeInbox = (conn: Connection, inbox: ImapSelected): void => {
    const read = conn.inboxRead;
    if (read === null) return;
    const isBehind =
      inbox.uidValidity !== read.uidValidity || (inbox.uidNext ?? 0) > (read.uidNext ?? 0);
    if (isBehind) reportChange(conn);
  };

  const wrapClient = (conn: Connection, socket: () => Socket, client: ImapClient): MailClient => {
    /** A refused SELECT, MOVE or APPEND may name a folder renamed or deleted elsewhere since LIST. */
    const forgetListOnRefusal = <T>(res: ImapResult<T>): ImapResult<T> => {
      if (!res.ok && res.reason.kind === 'no') conn.listed.clear();
      return res;
    };
    const select: ImapClient['select'] = async folderName => {
      // Commands go out in turn, so until this lands no one knows which folder the next one runs in:
      // a task that believed the last answer would send its command after this SELECT, into this folder.
      socket().selected = null;
      socket().selectedInfo = null;
      socket().selects += 1;
      const sent = socket().selects;
      // Always read-write: flag writes and APPEND need it, and EXAMINE would block them.
      const res = forgetListOnRefusal(await client.select(folderName, { readOnly: false }));
      // A SELECT sent after this one (a task queued while resting re-selected INBOX) is still
      // running, and the untagged answers on the wire are its folder's, not this one's.
      if (sent !== socket().selects) return res;
      socket().selected = res.ok ? folderName : null;
      socket().selectedInfo = res.ok ? res.value : null;
      if (res.ok) socket().exists = res.value.exists;
      return res;
    };
    return {
      ...client,
      // A fresh SELECT is how a sync reads a folder (`MailClient.ensureSelected`), so it is the caller's read.
      // ponytail: Older mail's page from an emptied window SELECTs afresh too; mail just before it waits (DECISIONS 2026-11-05).
      select: async folderName => {
        const res = await select(folderName);
        if (res.ok && folderName === 'INBOX') {
          conn.inboxRead = res.value;
          // Anything after this read is news, even within a second of the change that asked for it.
          conn.changedAt = null;
        }
        return res;
      },
      list: async (reference, pattern) => {
        const key = `${reference}\n${pattern}`;
        const known = conn.listed.get(key);
        if (known !== undefined) return { ok: true, value: known };
        const res = await client.list(reference, pattern);
        if (res.ok) conn.listed.set(key, res.value);
        return res;
      },
      move: async (uidSet, folderName) =>
        forgetListOnRefusal(await client.move(uidSet, folderName)),
      create: async folderName => {
        // Refused too: a folder that already exists is one the last LIST did not name.
        conn.listed.clear();
        return client.create(folderName);
      },
      append: async (folderName, message, flags, internalDate) => {
        conn.stallAfterMs = appendQuietLimitMs(message.length);
        try {
          return forgetListOnRefusal(await client.append(folderName, message, flags, internalDate));
        } finally {
          conn.stallAfterMs = STALL_MS;
          // A long wait is over, so the shorter limit does not count it.
          conn.progressAt = now();
        }
      },
      ensureSelected: async name => {
        const known = socket().selectedInfo;
        if (socket().selected === name && known !== null) return { ok: true, value: known };
        const res = await select(name);
        if (res.ok && name === 'INBOX') noticeInbox(conn, res.value);
        return res;
      },
    };
  };

  /** Detaches the socket now and settles once DONE and LOGOUT have gone out; `openSocket` waits on it. */
  const closeSocket = (conn: Connection): Promise<void> => {
    const socket = conn.socket;
    if (socket === null) return conn.teardown;
    conn.socket = null;
    conn.socketKey = null;
    clearKeepalive(conn);
    const idle = socket.idle;
    socket.idle = null;
    conn.teardown = (async () => {
      if (idle !== null) await idle.done().catch(() => {});
      await socket.close().catch(() => {});
    })();
    return conn.teardown;
  };

  const openSocket = async (
    conn: Connection,
    status: 'connecting' | 'reconnecting',
  ): Promise<Result<Socket, MailConnectionFailure>> => {
    await conn.teardown;
    setState(conn, { status });
    const controller = new AbortController();
    conn.abort = controller;
    const opened = await deps.connect(conn.imap, {
      onUntagged: untagged => handleUntagged(conn, untagged),
      onTraffic: () => {
        conn.progressAt = now();
      },
      signal: controller.signal,
    });
    if (!opened.ok) {
      // A handshake or login that hung was ended by `stall`, and fails as what it was.
      const error = controller.signal.aborted ? STALLED : opened.error;
      setFailed(conn, error);
      return { ok: false, error };
    }
    // `wrapClient` needs the socket it belongs to, which does not exist until the client does.
    const socket: Socket = {
      client: wrapClient(conn, () => socket, opened.value.client),
      close: opened.value.close,
      resumed: opened.value.resumed,
      idle: null,
      selected: null,
      selectedInfo: null,
      exists: 0,
      selects: 0,
    };
    conn.socket = socket;
    conn.socketKey = conn.imapKey;
    setState(conn, { status: 'live', resumed: socket.resumed, idling: false });
    return { ok: true, value: socket };
  };

  /** A socket whose credentials were edited since it opened is closed between tasks, never mid-task. */
  const dropStaleSocket = (conn: Connection): Promise<void> =>
    conn.socket !== null && conn.socketKey !== conn.imapKey ? closeSocket(conn) : conn.teardown;

  /** Ends the current IDLE, if any, so a command can go out. */
  const stopIdle = async (conn: Connection): Promise<void> => {
    const socket = conn.socket;
    if (socket === null || socket.idle === null) return;
    const idle = socket.idle;
    socket.idle = null;
    clearKeepalive(conn);
    await idle.done();
    if (conn.socket === socket) {
      setState(conn, { status: 'live', resumed: socket.resumed, idling: false });
    }
  };

  const canRest = (conn: Connection): boolean =>
    conn.pumping === null && conn.userQueue.length === 0 && conn.backgroundQueue.length === 0;

  /** Holds INBOX in IDLE until a task needs the connection or the server ends it. */
  const idleUntilNeeded = async (conn: Connection, socket: Socket): Promise<void> => {
    if (socket.selected !== 'INBOX') {
      const selectRes = await socket.client.ensureSelected('INBOX');
      if (!selectRes.ok) {
        const failure: MailConnectionFailure = { kind: 'imap', reason: selectRes.reason };
        if (isTransportFailure(failure) && conn.socket === socket) {
          await closeSocket(conn);
          setFailed(conn, failure);
        }
        return;
      }
      // A task may have arrived during the SELECT; it takes the connection.
      if (!canRest(conn) || conn.socket !== socket) return;
    }

    const idle = socket.client.idle();
    socket.idle = idle;
    setState(conn, { status: 'live', resumed: socket.resumed, idling: true });
    conn.keepalive = setTimer(() => {
      conn.keepalive = null;
      void stopIdle(conn).then(() => rest(conn));
    }, IDLE_REFRESH_MS);

    const ended = await idle.ended;
    // `stopIdle` took it: whoever called that owns what happens next.
    if (socket.idle !== idle) return;
    // Ended on its own: the server or the network dropped it.
    socket.idle = null;
    if (conn.socket !== socket) return;
    await closeSocket(conn);
    const failure: MailConnectionFailure = ended.ok
      ? { kind: 'error', detail: 'IDLE ended without DONE' }
      : { kind: 'imap', reason: ended.reason };
    const droppedAt = now();
    const tooSoon =
      conn.idleDroppedAt !== null && droppedAt - conn.idleDroppedAt < IDLE_RECONNECT_MIN_GAP_MS;
    conn.idleDroppedAt = droppedAt;
    if (tooSoon) {
      setFailed(conn, failure);
      return;
    }
    const reopened = await openSocket(conn, 'reconnecting');
    if (reopened.ok) rest(conn);
  };

  /** The no-IDLE fallback: one minute tick, NOOP every fifth, ask for a sync every second. */
  const scheduleTick = (conn: Connection): void => {
    conn.keepalive = setTimer(() => {
      conn.keepalive = null;
      void (async () => {
        const socket = conn.socket;
        // A task took over; `pump` reschedules when it is done.
        if (socket === null || !canRest(conn)) return;
        conn.tickMinutes += 1;
        if (conn.tickMinutes % NOOP_EVERY_MINUTES === 0) {
          const res = await socket.client.noop();
          if (!res.ok && conn.socket === socket) {
            const failure: MailConnectionFailure = { kind: 'imap', reason: res.reason };
            if (isTransportFailure(failure)) {
              await closeSocket(conn);
              setFailed(conn, failure);
              return;
            }
          }
        }
        if (conn.tickMinutes % POLL_EVERY_MINUTES === 0) reportChange(conn);
        if (conn.socket === socket && canRest(conn) && conn.keepalive === null) scheduleTick(conn);
      })();
    }, TICK_MS);
  };

  /** Nothing queued: idle in INBOX, or tick, until something is. */
  const rest = (conn: Connection): void => {
    const socket = conn.socket;
    if (socket === null || !canRest(conn) || socket.idle !== null || conn.keepalive !== null) {
      return;
    }
    if (conn.socketKey !== conn.imapKey) {
      void closeSocket(conn).then(() => setState(conn, CLOSED));
      return;
    }
    if (socket.client.hasCapability('IDLE')) {
      void idleUntilNeeded(conn, socket);
    } else {
      scheduleTick(conn);
    }
  };

  type Attempt = {
    readonly result: Result<unknown, MailConnectionFailure>;
    /** The socket is not trusted after this: a transport failure, or the task threw on it. */
    readonly socketLost: boolean;
  };

  const attempt = async (
    conn: Connection,
    task: MailTask<unknown>,
    status: 'connecting' | 'reconnecting',
  ): Promise<Attempt> => {
    await dropStaleSocket(conn);
    const opened =
      conn.socket === null
        ? await openSocket(conn, status)
        : { ok: true as const, value: conn.socket };
    if (!opened.ok) return { result: opened, socketLost: false };
    const signal = conn.abort?.signal;
    try {
      const result = await task.run(opened.value.client);
      // Ended by `stall`: the closed socket is how it was ended, not what went wrong.
      if (!result.ok && signal?.aborted === true) {
        return { result: { ok: false, error: STALLED }, socketLost: true };
      }
      return { result, socketLost: !result.ok && isTransportFailure(result.error) };
    } catch (error) {
      // A throw is a bug or a dead transport; either way this socket is not trusted again.
      return {
        result: {
          ok: false,
          error: { kind: 'error', detail: error instanceof Error ? error.message : String(error) },
        },
        socketLost: true,
      };
    }
  };

  const runOne = async (conn: Connection, { task, resolve }: Queued): Promise<void> => {
    conn.progressAt = now();
    let last = await attempt(conn, task, 'connecting');
    if (last.socketLost && task.retry) {
      await closeSocket(conn);
      last = await attempt(conn, task, 'reconnecting');
    }
    if (last.socketLost && !last.result.ok) {
      await closeSocket(conn);
      setFailed(conn, last.result.error);
    }
    conn.progressAt = now();
    resolve(last.result);
  };

  const pump = (conn: Connection): void => {
    if (conn.pumping !== null) return;
    conn.pumping = (async () => {
      clearKeepalive(conn);
      await stopIdle(conn);
      for (;;) {
        const next = conn.userQueue.shift() ?? conn.backgroundQueue.shift();
        if (next === undefined) return;
        await runOne(conn, next);
      }
    })().finally(() => {
      conn.pumping = null;
      // A task queued after the loop found the queues empty, but before this ran, saw it still
      // pumping and started nothing; left there, it would wait for ever.
      if (conn.userQueue.length > 0 || conn.backgroundQueue.length > 0) {
        pump(conn);
      } else {
        // Not this turn: work that goes task by task, as a search and a sync do, queues its next as
        // the last one's answer lands, and resting between them is a SELECT INBOX, an IDLE and a
        // DONE each time, to a server that may be throttling. `rest` finds out if one arrived.
        setTimer(() => rest(conn), 0);
      }
    });
  };

  const hasWork = (conn: Connection): boolean =>
    conn.pumping !== null || conn.userQueue.length > 0 || conn.backgroundQueue.length > 0;

  /**
   * Work waiting and nothing moving past its limit: a server that stopped answering, or a queue that
   * stopped running. Either way it is reported rather than waited on for ever: what is queued fails
   * as `stalled`, and the socket being opened or open is ended at once, so a handshake, a login or a
   * task blocked on it fails as `stalled` too (a task is retried once on a new socket if it may be).
   */
  const stall = (conn: Connection): void => {
    // biome-ignore lint/suspicious/noConsole: a stall is a bug or a dead server, and nothing else records it
    console.error(
      JSON.stringify({
        event: 'mail-stalled',
        address: conn.address,
        running: conn.pumping !== null,
        queued: conn.userQueue.length + conn.backgroundQueue.length,
      }),
    );
    // Reported once per limit, not on every check.
    conn.progressAt = now();
    rejectQueued(conn, STALLED);
    // Not `closeSocket`: its LOGOUT would queue behind the very command that is not answered.
    conn.abort?.abort();
    setFailed(conn, STALLED);
  };

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /** Checks while any connection has work, and stops when none has. */
  const watch = (): void => {
    if (watchdog !== null) return;
    watchdog = setTimer(() => {
      watchdog = null;
      const busy = [...connections.values()].filter(hasWork);
      for (const conn of busy) {
        if (now() - conn.progressAt >= conn.stallAfterMs) stall(conn);
      }
      if (busy.length > 0) watch();
    }, STALL_CHECK_MS);
  };

  const getOrCreate = (mailbox: InboundAddress): Connection => {
    const key = imapKeyOf(mailbox.imap);
    const existing = connections.get(mailbox.address);
    if (existing !== undefined) {
      // Changed credentials: the running task finishes on the socket it started on, and
      // `dropStaleSocket` closes it before the next one starts. Never a LOGOUT mid-task.
      if (existing.imapKey !== key) existing.listed.clear();
      existing.imap = mailbox.imap;
      existing.imapKey = key;
      return existing;
    }
    const conn: Connection = {
      address: mailbox.address,
      imap: mailbox.imap,
      imapKey: key,
      socket: null,
      socketKey: null,
      teardown: Promise.resolve(),
      state: CLOSED,
      userQueue: [],
      backgroundQueue: [],
      pumping: null,
      keepalive: null,
      tickMinutes: 0,
      changedAt: null,
      inboxRead: null,
      idleDroppedAt: null,
      listed: new Map(),
      progressAt: now(),
      stallAfterMs: STALL_MS,
      abort: null,
    };
    connections.set(mailbox.address, conn);
    return conn;
  };

  /** Finishes the running task, drops the queued ones, LOGOUTs. The record stays for a later reopen. */
  const shutdown = async (conn: Connection): Promise<void> => {
    rejectQueued(conn, CONNECTION_CLOSED);
    await conn.pumping;
    clearKeepalive(conn);
    await closeSocket(conn);
    setState(conn, CLOSED);
  };

  return {
    run: (mailbox, task) =>
      new Promise(resolve => {
        const conn = getOrCreate(mailbox);
        // An idle connection's last progress is old news; the clock starts with this work.
        if (!hasWork(conn)) conn.progressAt = now();
        const end = deps.activity?.begin({ effect: task.effect, priority: task.priority });
        const queued: Queued = {
          task: task as MailTask<unknown>,
          resolve: result => {
            end?.();
            resolve(result as Result<never, MailConnectionFailure>);
          },
        };
        if (task.signal?.aborted === true) {
          queued.resolve({ ok: false, error: CANCELLED });
          return;
        }
        // Still queued when it aborts, it leaves the queue unsent; running, it stops itself.
        task.signal?.addEventListener(
          'abort',
          () => {
            const queue = conn.userQueue.includes(queued) ? conn.userQueue : conn.backgroundQueue;
            const index = queue.indexOf(queued);
            if (index === -1) return;
            queue.splice(index, 1);
            queued.resolve({ ok: false, error: CANCELLED });
          },
          { once: true },
        );
        if (task.priority === 'user') {
          conn.userQueue.push(queued);
        } else {
          conn.backgroundQueue.push(queued);
        }
        pump(conn);
        watch();
      }),

    close: async address => {
      const conn = connections.get(address);
      if (conn === undefined) return;
      await shutdown(conn);
      connections.delete(address);
    },

    closeAll: async () => {
      await Promise.all([...connections.values()].map(conn => shutdown(conn)));
      connections.clear();
    },

    state: address => connections.get(address)?.state ?? CLOSED,
  };
};
