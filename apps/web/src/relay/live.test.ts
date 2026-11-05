import type { ImapClient, ImapIdle, ImapResult, ImapSelected, ImapUntagged } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, MailTask, RunTask } from '@yozz.app/mail/connection';
import { memoryMailCache } from '@yozz.app/mail/testing/memory-mail-cache';
import { parseQuery } from '@yozz.app/mail/threads/query';
import { searchMailbox } from '@yozz.app/mail/threads/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivityTracker } from './activity';
import { createLiveManager, type LiveState } from './live';

type FakeClient = ImapClient & {
  readonly selects: string[];
  noops: number;
  logouts: number;
  readonly emitUntagged: (untagged: ImapUntagged) => void;
  readonly endIdle: (result: ImapResult<void>) => void;
  failNext: MailConnectionFailure | null;
};

const MAILBOX: InboundAddress = {
  address: 'me@x.test',
  smtp: { host: 'smtp.x', port: 465, username: 'me', password: 'p' },
  imap: { host: 'imap.x', port: 993, username: 'me', password: 'p' },
};

const selected = (name: string): ImapSelected => ({
  name,
  exists: 0,
  uidValidity: 1,
  uidNext: 1,
  flags: [],
  permanentFlags: [],
  readOnly: false,
});

const createFakeClient = (capabilities: readonly string[] = ['IDLE']): FakeClient => {
  let onUntagged: ((u: ImapUntagged) => void) | undefined;
  let idleResolve: ((result: ImapResult<void>) => void) | undefined;
  let idleDoneRequested = false;

  const client: FakeClient = {
    selects: [],
    noops: 0,
    logouts: 0,
    failNext: null,
    emitUntagged: untagged => onUntagged?.(untagged),
    endIdle: result => {
      idleResolve?.(result);
      idleResolve = undefined;
    },
    greeting: async () => ({ ok: true, value: { text: 'ready', capabilities: [...capabilities] } }),
    capability: async () => ({ ok: true, value: [...capabilities] }),
    capabilities: () => [...capabilities],
    hasCapability: name => capabilities.some(c => c.toUpperCase() === name.toUpperCase()),
    authenticate: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    select: async name => {
      client.selects.push(name);
      return { ok: true, value: selected(name) };
    },
    fetchSummaries: async () => ({ ok: true, value: [] }),
    fetchSummariesBySeq: async () => ({ ok: true, value: [] }),
    fetchFlags: async () => ({ ok: true, value: [] }),
    fetchRaw: async () => ({ ok: true, value: new Uint8Array() }),
    storeFlags: async () => ({ ok: true, value: undefined }),
    append: async () => ({ ok: true, value: null }),
    expunge: async () => ({ ok: true, value: undefined }),
    uidExpunge: async () => ({ ok: true, value: undefined }),
    move: async () => ({ ok: true, value: null }),
    create: async () => ({ ok: true, value: undefined }),
    noop: async () => {
      client.noops += 1;
      return { ok: true, value: undefined };
    },
    idle: (): ImapIdle => {
      idleDoneRequested = false;
      const ended = new Promise<ImapResult<void>>(resolve => {
        idleResolve = result => {
          resolve(result);
        };
      });
      return {
        done: async () => {
          if (!idleDoneRequested) {
            idleDoneRequested = true;
            idleResolve?.({ ok: true, value: undefined });
            idleResolve = undefined;
          }
          return ended;
        },
        ended,
      };
    },
    uidSearch: async () => ({ ok: true, value: [] }),
    fetchAttachmentNames: async () => ({ ok: true, value: [] }),
    logout: async () => {
      client.logouts += 1;
      return { ok: true, value: undefined };
    },
  };

  (
    client as FakeClient & { setOnUntagged: (fn: (u: ImapUntagged) => void) => void }
  ).setOnUntagged = fn => {
    onUntagged = fn;
  };

  return client;
};

describe('createLiveManager', () => {
  let clients: FakeClient[];
  let states: LiveState[];
  let mailboxChanges: string[];
  let nowMs: number;
  let timers: { id: number; fire: () => void; at: number }[];
  let nextTimerId: number;
  /** The newest connection's traffic report, as `connectImap` would make it. */
  let traffic: (() => void) | undefined;

  beforeEach(() => {
    clients = [];
    states = [];
    mailboxChanges = [];
    nowMs = 1_000_000;
    timers = [];
    nextTimerId = 1;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setTimer = (fn: () => void, ms: number) => {
    const id = nextTimerId++;
    timers.push({ id, fire: fn, at: nowMs + ms });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  const clearTimer = (id: ReturnType<typeof setTimeout>) => {
    timers = timers.filter(t => t.id !== (id as unknown as number));
  };

  /** Settles the promise chains a timer callback or a finished task leaves behind. */
  const flush = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
    // A connection goes to rest on a timer of no delay.
    const due = timers.filter(timer => timer.at <= nowMs);
    timers = timers.filter(timer => timer.at > nowMs);
    for (const { fire } of due) fire();
    for (let i = 0; i < 25; i++) await Promise.resolve();
  };

  const advance = async (ms: number) => {
    const target = nowMs + ms;
    while (true) {
      const due = timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0];
      if (next === undefined) break;
      timers = timers.filter(t => t.id !== next.id);
      nowMs = next.at;
      next.fire();
      await flush();
    }
    nowMs = target;
  };

  const createManager = (
    capabilities: readonly string[] = ['IDLE'],
    activity = createActivityTracker(),
  ) => {
    let connectCount = 0;
    return createLiveManager({
      activity,
      now: () => nowMs,
      setTimer: setTimer as typeof setTimeout,
      clearTimer: clearTimer as typeof clearTimeout,
      connect: async (_imap, options) => {
        connectCount += 1;
        traffic = options?.onTraffic;
        const client = createFakeClient(capabilities);
        (
          client as FakeClient & { setOnUntagged: (fn: (u: ImapUntagged) => void) => void }
        ).setOnUntagged(untagged => options?.onUntagged?.(untagged));
        if (client.failNext !== null) {
          const failure = client.failNext;
          return { ok: false, error: failure };
        }
        clients.push(client);
        return {
          ok: true,
          value: {
            client,
            close: async () => {
              await client.logout();
            },
            resumed: connectCount > 1,
          },
        };
      },
      onState: (_address, state) => {
        states.push(state);
      },
      onMailboxChanged: address => {
        mailboxChanges.push(address);
      },
    });
  };

  /** A task the server never answers, unless the test settles it. */
  const hanging = () => {
    let settle = () => {};
    const task: MailTask<number> = {
      priority: 'user',
      effect: 'read',
      retry: false,
      run: () =>
        new Promise(resolve => {
          settle = () => resolve({ ok: true, value: 1 });
        }),
    };
    return { task, settle: () => settle() };
  };
  const quick: MailTask<number> = {
    priority: 'background',
    effect: 'read',
    retry: true,
    run: async () => ({ ok: true, value: 2 }),
  };

  it('tells the tracker of every task from the moment it is queued until it settles', async () => {
    const activity = createActivityTracker();
    const manager = createManager(['IDLE'], activity);
    const slow = hanging();
    const running = manager.run(MAILBOX, { ...slow.task, effect: 'write' });
    const queued = manager.run(MAILBOX, quick);
    await flush();
    expect(activity.snapshot()).toMatchObject([
      { effect: 'write', priority: 'user' },
      { effect: 'read', priority: 'background' },
    ]);

    slow.settle();
    await Promise.all([running, queued]);
    expect(activity.snapshot()).toEqual([]);
  });

  it('fails the work behind a server that stops answering, a minute after it last moved', async () => {
    const manager = createManager();
    void manager.run(MAILBOX, hanging().task);
    let behind: unknown = 'waiting';
    void manager.run(MAILBOX, quick).then(result => {
      behind = result;
    });
    await flush();

    await advance(50_000);
    expect(behind).toBe('waiting');
    await advance(20_000);
    expect(behind).toEqual({ ok: false, error: { kind: 'stalled' } });
    expect(states.at(-1)).toMatchObject({ status: 'failed', failure: { kind: 'stalled' } });
  });

  /** A manager over one `connect`, with the test's clock. */
  const managerOver = (
    connect: Parameters<typeof createLiveManager>[0]['connect'],
    activity = createActivityTracker(),
  ) =>
    createLiveManager({
      now: () => nowMs,
      setTimer: setTimer as typeof setTimeout,
      clearTimer: clearTimer as typeof clearTimeout,
      activity,
      connect,
      onState: (_address, state) => {
        states.push(state);
      },
      onMailboxChanged: () => {},
    });
  const whenAborted = (signal: AbortSignal | undefined) =>
    new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve()));

  it('ends a socket whose command is never answered, without a LOGOUT that would wait behind it', async () => {
    const activity = createActivityTracker();
    let aborted: Promise<void> = new Promise(() => {});
    const manager = managerOver(async (_imap, options) => {
      aborted = whenAborted(options?.signal);
      return {
        ok: true,
        // A graceful close queues LOGOUT behind the silent command: it ends only with the socket.
        value: { client: createFakeClient(), close: () => aborted, resumed: false },
      };
    }, activity);
    const write = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'write',
      retry: false,
      run: async () => {
        await aborted;
        return { ok: false, error: { kind: 'imap', reason: { kind: 'closed' } } };
      },
    });
    await flush();

    await advance(70_000);
    expect(await write).toEqual({ ok: false, error: { kind: 'stalled' } });
    expect(activity.snapshot()).toEqual([]);
  });

  it('ends a handshake or login that never finishes', async () => {
    const activity = createActivityTracker();
    const manager = managerOver(
      (_imap, options) =>
        whenAborted(options?.signal).then(() => ({
          ok: false,
          error: { kind: 'relay', detail: 'cancelled' },
        })),
      activity,
    );
    const read = manager.run(MAILBOX, quick);
    await flush();

    await advance(70_000);
    expect(await read).toEqual({ ok: false, error: { kind: 'stalled' } });
    expect(states.at(-1)).toMatchObject({ status: 'failed', failure: { kind: 'stalled' } });
    expect(activity.snapshot()).toEqual([]);
  });

  it('leaves slow work alone while bytes keep crossing the connection', async () => {
    const manager = createManager();
    const slow = hanging();
    const running = manager.run(MAILBOX, slow.task);
    await flush();
    for (let minute = 0; minute < 6; minute++) {
      await advance(30_000);
      traffic?.();
    }
    expect(states.some(state => state.status === 'failed')).toBe(false);

    slow.settle();
    expect(await running).toEqual({ ok: true, value: 1 });
  });

  describe('an APPEND waiting for its reply', () => {
    const MIB = 2 ** 20;

    /** A connection whose APPEND is written whole and answered only when the test says, or the socket ends. */
    const appending = (activity = createActivityTracker(), close = async () => {}) => {
      const answer = Promise.withResolvers<ImapResult<null>>();
      const manager = managerOver(async (_imap, options) => {
        options?.signal?.addEventListener('abort', () =>
          answer.resolve({ ok: false, reason: { kind: 'closed' } }),
        );
        return {
          ok: true,
          value: {
            client: { ...createFakeClient(), append: () => answer.promise },
            close,
            resumed: false,
          },
        };
      }, activity);
      const append = (bytes: number): Promise<unknown> =>
        manager.run(MAILBOX, {
          priority: 'user',
          effect: 'write',
          retry: false,
          run: async client => {
            const appended = await client.append('Sent', new Uint8Array(bytes), []);
            return appended.ok
              ? { ok: true, value: appended.value }
              : { ok: false, error: { kind: 'imap', reason: appended.reason } };
          },
        });
      return { manager, append, answer };
    };

    it('survives the minutes a server takes over a large message', async () => {
      const { append, answer } = appending();
      const written = append(33 * MIB);
      await flush();

      await advance(6 * 60_000);
      expect(states.some(state => state.status === 'failed')).toBe(false);

      answer.resolve({ ok: true, value: null });
      expect(await written).toEqual({ ok: true, value: null });
    });

    it('fails as stalled when the server never answers a large one', async () => {
      const { append } = appending();
      const written = append(33 * MIB);
      await flush();

      await advance(10 * 60_000);
      expect(await written).toEqual({ ok: false, error: { kind: 'stalled' } });
      expect(states.at(-1)).toMatchObject({ status: 'failed', failure: { kind: 'stalled' } });
    });

    it('gives a small one about the minute everything else gets, so the queue moves on', async () => {
      const { manager, append } = appending();
      const written = append(1024);
      let behind: unknown = 'waiting';
      void manager.run(MAILBOX, quick).then(result => {
        behind = result;
      });
      await flush();

      await advance(50_000);
      expect(behind).toBe('waiting');
      await advance(30_000);
      expect(behind).toEqual({ ok: false, error: { kind: 'stalled' } });
      expect(await written).toEqual({ ok: false, error: { kind: 'stalled' } });
    });

    it('does not call a dropped connection a stall on what queued behind it', async () => {
      const closing = Promise.withResolvers<void>();
      const { manager, append, answer } = appending(undefined, () => closing.promise);
      const written = append(33 * MIB);
      let behind: unknown = 'waiting';
      void manager.run(MAILBOX, quick).then(result => {
        behind = result;
      });
      await flush();
      await advance(5 * 60_000);

      // Lost past the minute the next task gets, and the socket takes a moment to close: that wait
      // is not the next task's.
      answer.resolve({ ok: false, reason: { kind: 'closed' } });
      await flush();
      await advance(20_000);
      expect(behind).toBe('waiting');
      expect(states.some(state => state.status === 'failed')).toBe(false);

      closing.resolve();
      await written;
      await flush();
      expect(behind).not.toEqual({ ok: false, error: { kind: 'stalled' } });
    });

    it('takes its long limit with it when it is answered', async () => {
      const { manager, append, answer } = appending();
      answer.resolve({ ok: true, value: null });
      await append(33 * MIB);

      const read = manager.run(MAILBOX, hanging().task);
      await flush();
      await advance(70_000);
      expect(states.at(-1)).toMatchObject({ status: 'failed', failure: { kind: 'stalled' } });
      void read;
    });
  });

  it('runs a task queued at any moment after the one before it finishes', async () => {
    const task: MailTask<number> = {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: 1 }),
    };
    for (let delay = 0; delay < 12; delay++) {
      const manager = createManager();
      const second = manager.run(MAILBOX, task).then(async () => {
        for (let i = 0; i < delay; i++) await Promise.resolve();
        return manager.run(MAILBOX, task);
      });
      let isDone = false;
      void second.then(() => {
        isDone = true;
      });
      await flush();
      await flush();
      expect({ delay, isDone }).toEqual({ delay, isDone: true });
    }
  });

  it('drops a queued task whose signal aborts, and never starts one already aborted', async () => {
    const client = createFakeClient();
    const manager = createLiveManager({
      connect: async () => ({
        ok: true,
        value: { client, close: async () => {}, resumed: false },
      }),
      onMailboxChanged: () => {},
    });
    const gate = Promise.withResolvers<void>();
    const running = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: false,
      run: async () => {
        await gate.promise;
        return { ok: true, value: 'first' };
      },
    });
    const controller = new AbortController();
    const started: string[] = [];
    const queued = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: false,
      signal: controller.signal,
      run: async () => {
        started.push('queued');
        return { ok: true, value: 'queued' };
      },
    });
    controller.abort();
    // It answers at once, without waiting for its turn.
    await expect(queued).resolves.toEqual({ ok: false, error: { kind: 'cancelled' } });
    await expect(
      manager.run(MAILBOX, {
        priority: 'user',
        effect: 'read',
        retry: false,
        signal: controller.signal,
        run: async () => {
          started.push('late');
          return { ok: true, value: 'late' };
        },
      }),
    ).resolves.toEqual({ ok: false, error: { kind: 'cancelled' } });

    gate.resolve();
    await expect(running).resolves.toEqual({ ok: true, value: 'first' });
    expect(started).toEqual([]);
    await manager.closeAll();
  });

  describe('a search on the connection', () => {
    /** Answers by the folder selected, so a search asking in the wrong one gets the wrong uids. */
    const answers: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {
      INBOX: { SUBJECT: [1], FROM: [2], TO: [], CC: [], HEADER: [], TEXT: [3] },
      Archive: { SUBJECT: [50], FROM: [], TO: [], CC: [], HEADER: [], TEXT: [] },
    };
    const mailCache = async () => {
      const cache = memoryMailCache();
      await cache
        .folder('inbox')
        .putSync({ name: 'INBOX', uidValidity: 1, lastUid: 3, complete: true });
      await cache
        .folder('archive')
        .putSync({ name: 'Archive', uidValidity: 1, lastUid: 50, complete: true });
      return cache;
    };
    type Hold = { key: string | null; release?: () => void; reached?: () => void };

    /** A live connection already resting in the inbox, whose client logs every command as it goes out. */
    const start = async (hold: Hold) => {
      const log: string[] = [];
      const manager = createLiveManager({
        now: () => nowMs,
        setTimer: setTimer as typeof setTimeout,
        clearTimer: clearTimer as typeof clearTimeout,
        onMailboxChanged: () => {},
        connect: async () => {
          const fake = createFakeClient();
          let current: string | null = null;
          const client: FakeClient = {
            ...fake,
            select: async (name, options) => {
              log.push(`SELECT ${name}`);
              current = name;
              return fake.select(name, options);
            },
            idle: () => {
              log.push('IDLE');
              return fake.idle();
            },
            uidSearch: async criterion => {
              log.push(`SEARCH ${current} ${criterion.key}`);
              if (hold.key === criterion.key) {
                hold.key = null;
                hold.reached?.();
                await new Promise<void>(resolve => {
                  hold.release = resolve;
                });
              }
              return { ok: true, value: answers[current ?? '']?.[criterion.key] ?? [] };
            },
          };
          return { ok: true, value: { client, close: async () => {}, resumed: false } };
        },
      });
      await manager.run(MAILBOX, {
        priority: 'user',
        effect: 'read',
        retry: false,
        run: async () => ({ ok: true, value: null }),
      });
      await flush();
      log.length = 0;
      // As the store hands it out: `bindRunOn`'s runner is an async function.
      const run: RunTask = async task => manager.run(MAILBOX, task);
      return { manager, log, run };
    };

    it('lets a task queued mid-search run before its next command, and still answers right', async () => {
      const reached = Promise.withResolvers<void>();
      const hold: Hold = { key: 'FROM', reached: reached.resolve };
      const { manager, log, run } = await start(hold);
      const searching = searchMailbox({
        run,
        cache: await mailCache(),
        folders: ['inbox', 'archive'],
        query: parseQuery('needle'),
      });
      await reached.promise;

      // A message opened while the command is on the wire: it moves the connection elsewhere.
      const opened = manager.run(MAILBOX, {
        priority: 'user',
        effect: 'read',
        retry: true,
        run: async client => {
          await client.ensureSelected('Trash');
          log.push('OPEN');
          return { ok: true, value: 'opened' };
        },
      });
      hold.release?.();
      await expect(opened).resolves.toEqual({ ok: true, value: 'opened' });
      const result = await searching;

      expect(log.slice(0, 7)).toEqual([
        'SEARCH INBOX SUBJECT',
        'SEARCH INBOX FROM',
        // Behind the one command that was on the wire, ahead of the five still to go.
        'SELECT Trash',
        'OPEN',
        // The connection moved, so the search selects its folder again before going on.
        'SELECT INBOX',
        'SEARCH INBOX TO',
        'SEARCH INBOX CC',
      ]);
      if (!result.ok) throw new Error('The search failed');
      expect(result.value.map(({ folder, hits }) => [folder, hits])).toEqual([
        ['inbox', [3, 2, 1]],
        ['archive', [50]],
      ]);
      await manager.closeAll();
    });

    it('goes from command to command without selecting again or resting in IDLE', async () => {
      const { manager, log, run } = await start({ key: null });
      const result = await searchMailbox({
        run,
        cache: await mailCache(),
        folders: ['inbox', 'archive'],
        query: parseQuery('needle'),
      });
      expect(result.ok).toBe(true);
      // Already in the inbox from resting there; one select to reach Archive, and no other.
      expect(log.filter(line => !line.startsWith('SEARCH'))).toEqual(['SELECT Archive']);
      expect(log.filter(line => line.startsWith('SEARCH INBOX'))).toHaveLength(6);
      expect(log.filter(line => line.startsWith('SEARCH Archive'))).toHaveLength(6);
      await manager.closeAll();
    });

    describe('a task arriving while the connection selects the inbox to rest', () => {
      /** A client whose commands go out one at a time, as the real one's do, and record where they ran. */
      const serialWorld = () => {
        const log: string[] = [];
        const held: { release: (() => void) | null } = { release: null };
        let current: string | null = null;
        let tail: Promise<unknown> = Promise.resolve();
        const inTurn = <T>(command: () => Promise<T>): Promise<T> => {
          const turn = tail.then(command);
          tail = turn;
          return turn;
        };
        const manager = createLiveManager({
          now: () => nowMs,
          setTimer: setTimer as typeof setTimeout,
          clearTimer: clearTimer as typeof clearTimeout,
          onMailboxChanged: () => {},
          connect: async () => {
            const fake = createFakeClient();
            const client: FakeClient = {
              ...fake,
              select: (name, options) =>
                inTurn(async () => {
                  log.push(`SELECT ${name}`);
                  if (name === 'INBOX') {
                    await new Promise<void>(resolve => {
                      held.release = resolve;
                    });
                  }
                  current = name;
                  return fake.select(name, options);
                }),
              move: (...args) =>
                inTurn(async () => {
                  log.push(`MOVE in ${current}`);
                  return fake.move(...args);
                }),
              idle: () => {
                log.push('IDLE');
                return fake.idle();
              },
            };
            return { ok: true, value: { client, close: async () => {}, resumed: false } };
          },
        });
        return { manager, log, held };
      };

      /** Selects the folder if it has to, then moves: what a write on a thread does. */
      const moveFrom = (folder: string): MailTask<void> => ({
        priority: 'user',
        effect: 'write',
        retry: false,
        run: async client => {
          const selectedNow = await client.ensureSelected(folder);
          if (!selectedNow.ok) {
            return { ok: false, error: { kind: 'imap', reason: selectedNow.reason } };
          }
          await client.move('1', 'Trash');
          return { ok: true, value: undefined };
        },
      });

      /** Archive selected, the task over, and the rest's `SELECT INBOX` on the wire. */
      const restingFromArchive = async () => {
        const world = serialWorld();
        await world.manager.run(MAILBOX, moveFrom('Archive'));
        await flush();
        expect(world.log).toEqual(['SELECT Archive', 'MOVE in Archive', 'SELECT INBOX']);
        world.log.length = 0;
        return world;
      };

      it('selects the folder it wants again, so its command runs there and not in the inbox', async () => {
        const { manager, log, held } = await restingFromArchive();
        const moved = manager.run(MAILBOX, moveFrom('Archive'));
        await flush();
        held.release?.();
        await moved;
        expect(log.slice(0, 2)).toEqual(['SELECT Archive', 'MOVE in Archive']);
        await manager.closeAll();
      });

      it('knows where it is once two selects have overlapped: tasks in a row select once', async () => {
        const { manager, log, held } = await restingFromArchive();
        const first = manager.run(MAILBOX, moveFrom('Archive'));
        const second = manager.run(MAILBOX, moveFrom('Archive'));
        await flush();
        held.release?.();
        await Promise.all([first, second]);
        expect(log.slice(0, 3)).toEqual(['SELECT Archive', 'MOVE in Archive', 'MOVE in Archive']);
        await manager.closeAll();
      });

      it('goes back to rest in the inbox afterwards, selecting it again', async () => {
        const { manager, log, held } = await restingFromArchive();
        const moved = manager.run(MAILBOX, moveFrom('Archive'));
        await flush();
        held.release?.();
        await moved;
        await flush();
        held.release?.();
        await flush();
        expect(log).toEqual(['SELECT Archive', 'MOVE in Archive', 'SELECT INBOX', 'IDLE']);
        await manager.closeAll();
      });

      it('idles once the select lands when nothing arrived', async () => {
        const { manager, log, held } = await restingFromArchive();
        held.release?.();
        await flush();
        expect(log).toEqual(['IDLE']);
        await manager.closeAll();
      });
    });

    it('rests in the inbox once the search is over', async () => {
      const { manager, log, run } = await start({ key: null });
      await searchMailbox({
        run,
        cache: await mailCache(),
        folders: ['archive'],
        query: parseQuery('needle'),
      });
      await flush();
      expect(log.slice(-2)).toEqual(['SELECT INBOX', 'IDLE']);
      await manager.closeAll();
    });
  });

  it('runs user tasks before background tasks', async () => {
    const manager = createManager();
    const order: string[] = [];
    const tasks = [
      manager.run(MAILBOX, {
        priority: 'user',
        effect: 'read',
        retry: true,
        run: async () => {
          order.push('u1');
          return { ok: true, value: 1 };
        },
      }),
      manager.run(MAILBOX, {
        priority: 'background',
        effect: 'read',
        retry: true,
        run: async () => {
          order.push('b1');
          return { ok: true, value: 2 };
        },
      }),
      manager.run(MAILBOX, {
        priority: 'user',
        effect: 'read',
        retry: true,
        run: async () => {
          order.push('u2');
          return { ok: true, value: 3 };
        },
      }),
    ];
    await Promise.all(tasks);
    expect(order).toEqual(['u1', 'u2', 'b1']);
  });

  it('ensureSelected skips a second SELECT of the same folder', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async client => {
        await client.ensureSelected('INBOX');
        await client.ensureSelected('INBOX');
        await client.select('Sent');
        await client.ensureSelected('INBOX');
        return { ok: true, value: undefined };
      },
    });
    expect(clients[0]?.selects).toEqual(['INBOX', 'Sent', 'INBOX']);
  });

  it('enters idle after the queue drains and done() runs before the next task', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));

    let ran = false;
    const next = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => {
        ran = true;
        expect(manager.state(MAILBOX.address)).toMatchObject({ status: 'live', idling: false });
        return { ok: true, value: undefined };
      },
    });
    await next;
    expect(ran).toBe(true);
  });

  it('debounces exists during idle to one onMailboxChanged per second', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    const client = clients[0];
    if (client === undefined) throw new Error('no client');
    client.emitUntagged({ kind: 'exists', count: 1 });
    client.emitUntagged({ kind: 'exists', count: 2 });
    client.emitUntagged({ kind: 'fetch', seq: 1, items: [] });
    expect(mailboxChanges).toEqual([MAILBOX.address]);
    await advance(1000);
    client.emitUntagged({ kind: 'expunge', seq: 1 });
    expect(mailboxChanges).toEqual([MAILBOX.address, MAILBOX.address]);
  });

  it('retries a transport failure once when retry is true', async () => {
    const manager = createManager();
    let attempts = 0;
    const result = await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            ok: false,
            error: { kind: 'imap', reason: { kind: 'closed' } },
          };
        }
        return { ok: true, value: 'ok' };
      },
    });
    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(attempts).toBe(2);
    expect(clients).toHaveLength(2);
  });

  it('does not retry when retry is false', async () => {
    const manager = createManager();
    let attempts = 0;
    const result = await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: false,
      run: async () => {
        attempts += 1;
        return {
          ok: false,
          error: { kind: 'imap', reason: { kind: 'closed' } },
        };
      },
    });
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(clients).toHaveLength(1);
  });

  it('keeps the connection open past the two minutes a hidden tab used to get, idling in INBOX', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));

    await advance(10 * 60 * 1000);
    expect(clients[0]?.logouts).toBe(0);
    expect(manager.state(MAILBOX.address)).toMatchObject({ status: 'live', idling: true });
    expect(clients).toHaveLength(1);
  });

  it('a connection that stays open still reports a mailbox change while idling', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    await advance(10 * 60 * 1000);

    clients[0]?.emitUntagged({ kind: 'exists', count: 3 });
    expect(mailboxChanges).toEqual([MAILBOX.address]);
    expect(clients[0]?.logouts).toBe(0);
  });

  it('closeAll LOGOUTs every connection and rejects queued tasks', async () => {
    const manager = createManager();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const running = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => {
        await gate;
        return { ok: true, value: 'done' };
      },
    });
    const queued = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: 'queued' }),
    });
    await Promise.resolve();
    const closing = manager.closeAll();
    release?.();
    const [runRes, queuedRes] = await Promise.all([running, queued]);
    await closing;
    expect(runRes).toEqual({ ok: true, value: 'done' });
    expect(queuedRes).toEqual({
      ok: false,
      error: { kind: 'error', detail: 'connection closed' },
    });
    expect(clients[0]?.logouts).toBe(1);
  });

  it('a changed password closes the old connection before the next task', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    const first = clients[0];
    if (first === undefined) throw new Error('no client');
    const changed: InboundAddress = {
      ...MAILBOX,
      imap: { ...MAILBOX.imap, password: 'new' },
    };
    await manager.run(changed, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    expect(first.logouts).toBe(1);
    expect(clients).toHaveLength(2);
  });

  it('a credential change never interrupts the running task; the old socket closes before the next', async () => {
    const manager = createManager();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const commandsAfterChange: number[] = [];
    const running = manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: false,
      run: async client => {
        await gate;
        // Still the first socket: the LOGOUT must not have gone out yet.
        await client.append('Sent', new Uint8Array(), []);
        commandsAfterChange.push(clients[0]?.logouts ?? -1);
        return { ok: true, value: 'appended' };
      },
    });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    const changed: InboundAddress = { ...MAILBOX, imap: { ...MAILBOX.imap, password: 'new' } };
    const next = manager.run(changed, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: 'second' }),
    });
    release?.();
    expect(await running).toEqual({ ok: true, value: 'appended' });
    expect(commandsAfterChange).toEqual([0]);
    expect(await next).toEqual({ ok: true, value: 'second' });
    expect(clients[0]?.logouts).toBe(1);
    expect(clients).toHaveLength(2);
  });

  it('a task that throws is retried once on a fresh socket, like a closed one', async () => {
    const manager = createManager();
    let attempts = 0;
    const result = await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        return { ok: true, value: 'ok' };
      },
    });
    expect(result).toEqual({ ok: true, value: 'ok' });
    expect(clients).toHaveLength(2);
    expect(clients[0]?.logouts).toBe(1);

    const twice = await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => {
        throw new Error('still boom');
      },
    });
    expect(twice).toEqual({ ok: false, error: { kind: 'error', detail: 'still boom' } });
    expect(manager.state(MAILBOX.address)).toMatchObject({ status: 'failed' });
  });

  it('without IDLE, NOOPs every 5 min and onMailboxChanged every 2 min, without piling up', async () => {
    const manager = createManager([]);
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    expect(clients[0]?.noops).toBe(0);
    await advance(2 * 60 * 1000);
    expect(mailboxChanges).toEqual([MAILBOX.address]);
    await advance(3 * 60 * 1000);
    expect(clients[0]?.noops).toBe(1);
    // Ten minutes in: five polls and two NOOPs, not a growing chain of timers.
    await advance(5 * 60 * 1000);
    expect(mailboxChanges).toHaveLength(5);
    expect(clients[0]?.noops).toBe(2);
  });

  it("ignores a command's own EXISTS/FETCH responses; only an idling connection reports a change", async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async client => {
        // What a SELECT and a body fetch answer with.
        clients[0]?.emitUntagged({ kind: 'exists', count: 9 });
        clients[0]?.emitUntagged({ kind: 'fetch', seq: 9, items: [] });
        await client.ensureSelected('INBOX');
        return { ok: true, value: undefined };
      },
    });
    expect(mailboxChanges).toEqual([]);
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    clients[0]?.emitUntagged({ kind: 'exists', count: 10 });
    expect(mailboxChanges).toEqual([MAILBOX.address]);
  });

  it('reopens and idles again when the server drops an IDLE', async () => {
    const manager = createManager();
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    clients[0]?.endIdle({ ok: false, reason: { kind: 'bye', text: 'Timeout' } });
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await flush();
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    expect(states.some(state => state.status === 'reconnecting')).toBe(true);
    // A second drop straight away is not chased.
    clients[1]?.endIdle({ ok: false, reason: { kind: 'bye', text: 'Timeout' } });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'failed' }));
    expect(clients).toHaveLength(2);
  });

  it('a transport failure that survives the retry marks the connection failed', async () => {
    const manager = createManager();
    const result = await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: false, error: { kind: 'imap', reason: { kind: 'closed' } } }),
    });
    expect(result.ok).toBe(false);
    expect(clients).toHaveLength(2);
    expect(manager.state(MAILBOX.address)).toMatchObject({ status: 'failed' });
    expect(clients.map(client => client.logouts)).toEqual([1, 1]);
  });

  it('without IDLE, keeps polling for mail past the two minutes, and never closes', async () => {
    const manager = createManager([]);
    await manager.run(MAILBOX, {
      priority: 'user',
      effect: 'read',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    await advance(10 * 60 * 1000);
    expect(mailboxChanges).toHaveLength(5);
    expect(clients[0]?.logouts).toBe(0);
    expect(manager.state(MAILBOX.address)).toMatchObject({ status: 'live', idling: false });
  });
});
