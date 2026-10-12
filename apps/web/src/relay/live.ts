import type { ImapClient, ImapIdle, ImapResult, ImapSelected, ImapUntagged } from '@yozz.app/imap';
import type { InboundAddress } from '../addresses/record';
import type { ActivityTracker } from './activity';
import type { MailConnection, MailConnectionFailure, Result } from './connection';

/**
 * Opened by the first task, kept while the tab is visible, holding `INBOX` in IDLE whenever nothing
 * is queued so the server can say "new mail" instead of being asked. Every IMAP touch is a task on
 * this queue; Connect's pre-store test is the one exception.
 */

export type LiveState =
  /** Nothing open: never opened, or closed by us (tab hidden, lock, address removed). */
  | { readonly status: 'closed' }
  | { readonly status: 'connecting' }
  | { readonly status: 'live'; readonly resumed: boolean; readonly idling: boolean }
  | { readonly status: 'reconnecting' }
  /** The server or the network ended it; the next task, or a visibility/online event, retries. */
  | { readonly status: 'failed'; readonly failure: MailConnectionFailure; readonly at: number };

export type LiveClient = ImapClient & {
  /**
   * SELECT only if `name` is not already the selected mailbox. Sync calls `client.select` directly
   * because it wants fresh UIDVALIDITY/UIDNEXT; body fetches and flag writes use this.
   */
  readonly ensureSelected: (name: string) => Promise<ImapResult<ImapSelected>>;
};

export type LiveTask<T> = {
  readonly run: (client: LiveClient) => Promise<Result<T, MailConnectionFailure>>;
  /** User-initiated work (open a body, a flag write, a sync) runs before prefetch. */
  readonly priority: 'user' | 'background';
  /** A `write` changes the mailbox (a move, a flag, an APPEND); a reload must not drop it unasked. */
  readonly effect: 'read' | 'write';
  /** Whether the task may be re-run on a fresh connection after a transport failure. APPEND must not. */
  readonly retry: boolean;
};

/** `LiveManager.run` for one account, as the mail store hands it out. */
export type RunOn = (
  account: InboundAddress,
) => <T>(task: LiveTask<T>) => Promise<Result<T, MailConnectionFailure>>;

export type LiveManager = {
  readonly run: <T>(
    account: InboundAddress,
    task: LiveTask<T>,
  ) => Promise<Result<T, MailConnectionFailure>>;
  readonly close: (address: string) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly setVisible: (visible: boolean) => void;
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
  readonly task: LiveTask<unknown>;
  readonly resolve: (result: Result<unknown, MailConnectionFailure>) => void;
};

/** An open, authenticated connection. Replaced whole on reconnect, never mutated back to life. */
type Socket = {
  readonly client: LiveClient;
  readonly close: () => Promise<void>;
  readonly resumed: boolean;
  idle: ImapIdle | null;
  selected: string | null;
  /** What the last SELECT answered, so a write can check the mailbox has not been renumbered. */
  selectedInfo: ImapSelected | null;
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
  idleDroppedAt: number | null;
  /** When work here last moved: bytes either way, a task starting or ending, or work arriving. */
  progressAt: number;
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

const HIDDEN_CLOSE_MS = 2 * 60 * 1000;
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
 * age: an APPEND of a large message may take minutes and is moving the whole time.
 */
const STALL_MS = 60 * 1000;
const STALL_CHECK_MS = 10 * 1000;

export const createLiveManager = (deps: {
  readonly connect: ConnectFn;
  readonly onState: (address: string, state: LiveState) => void;
  /** The server said the selected INBOX changed while idling (EXISTS/EXPUNGE/FETCH): the caller syncs. */
  readonly onMailboxChanged: (address: string) => void;
  /** Whether the tab is visible right now; `setVisible` tracks it from then on. */
  readonly visible?: boolean;
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
  let isVisible = deps.visible ?? true;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const setState = (conn: Connection, state: LiveState): void => {
    conn.state = state;
    deps.onState(conn.address, state);
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

  /** Only an unsolicited response while idling is "the mailbox changed": a command's own responses are the command's. */
  const handleUntagged = (conn: Connection, untagged: ImapUntagged): void => {
    if (conn.socket?.idle === null || conn.socket === null) return;
    if (untagged.kind !== 'exists' && untagged.kind !== 'expunge' && untagged.kind !== 'fetch') {
      return;
    }
    const at = now();
    if (conn.changedAt !== null && at - conn.changedAt < MAILBOX_CHANGE_THROTTLE_MS) return;
    conn.changedAt = at;
    deps.onMailboxChanged(conn.address);
  };

  const wrapClient = (socket: () => Socket, client: ImapClient): LiveClient => {
    const select: ImapClient['select'] = async mailbox => {
      // Always read-write: flag writes and APPEND need it, and EXAMINE would block them.
      const res = await client.select(mailbox, { readOnly: false });
      socket().selected = res.ok ? mailbox : null;
      socket().selectedInfo = res.ok ? res.value : null;
      return res;
    };
    return {
      ...client,
      select,
      ensureSelected: async name => {
        const known = socket().selectedInfo;
        if (socket().selected === name && known !== null) return { ok: true, value: known };
        return select(name);
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
      client: wrapClient(() => socket, opened.value.client),
      close: opened.value.close,
      resumed: opened.value.resumed,
      idle: null,
      selected: null,
      selectedInfo: null,
    };
    conn.socket = socket;
    conn.socketKey = conn.imapKey;
    setState(conn, { status: 'live', resumed: socket.resumed, idling: false });
    // A socket opened while the tab is hidden (a background unlock, a sync racing a hide) has the
    // same two-minute lifetime as one that was open when it hid.
    if (!isVisible) armHide();
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
    isVisible &&
    conn.pumping === null &&
    conn.userQueue.length === 0 &&
    conn.backgroundQueue.length === 0;

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
    if (!isVisible || tooSoon) {
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
        if (conn.tickMinutes % POLL_EVERY_MINUTES === 0) deps.onMailboxChanged(conn.address);
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
    task: LiveTask<unknown>,
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
        rest(conn);
      }
    });
  };

  const hasWork = (conn: Connection): boolean =>
    conn.pumping !== null || conn.userQueue.length > 0 || conn.backgroundQueue.length > 0;

  /**
   * Work waiting and nothing moving for a minute: a server that stopped answering, or a queue that
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
    // Reported once a minute, not on every check.
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
        if (now() - conn.progressAt >= STALL_MS) stall(conn);
      }
      if (busy.length > 0) watch();
    }, STALL_CHECK_MS);
  };

  const getOrCreate = (account: InboundAddress): Connection => {
    const key = imapKeyOf(account.imap);
    const existing = connections.get(account.address);
    if (existing !== undefined) {
      // Changed credentials: the running task finishes on the socket it started on, and
      // `dropStaleSocket` closes it before the next one starts. Never a LOGOUT mid-task.
      existing.imap = account.imap;
      existing.imapKey = key;
      return existing;
    }
    const conn: Connection = {
      address: account.address,
      imap: account.imap,
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
      idleDroppedAt: null,
      progressAt: now(),
      abort: null,
    };
    connections.set(account.address, conn);
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

  const armHide = (): void => {
    if (hideTimer !== null) return;
    hideTimer = setTimer(() => {
      hideTimer = null;
      for (const conn of connections.values()) void shutdown(conn);
    }, HIDDEN_CLOSE_MS);
  };

  return {
    run: (account, task) =>
      new Promise(resolve => {
        const conn = getOrCreate(account);
        // An idle connection's last progress is old news; the clock starts with this work.
        if (!hasWork(conn)) conn.progressAt = now();
        const end = deps.activity?.begin({ effect: task.effect, priority: task.priority });
        const queued: Queued = {
          task: task as LiveTask<unknown>,
          resolve: result => {
            end?.();
            resolve(result as Result<never, MailConnectionFailure>);
          },
        };
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

    setVisible: visible => {
      isVisible = visible;
      if (hideTimer !== null) {
        clearTimer(hideTimer);
        hideTimer = null;
      }
      if (visible) {
        for (const conn of connections.values()) rest(conn);
        return;
      }
      armHide();
    },

    state: address => connections.get(address)?.state ?? CLOSED,
  };
};
