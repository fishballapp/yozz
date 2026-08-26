import type { ImapClient, ImapIdle, ImapResult, ImapSelected, ImapUntagged } from '@yozz.app/imap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundAddress } from '../lib/addresses';
import type { MailConnectionFailure } from './connection';
import { createLiveManager, type LiveState } from './live';

type FakeClient = ImapClient & {
  readonly selects: string[];
  noops: number;
  logouts: number;
  readonly emitUntagged: (untagged: ImapUntagged) => void;
  readonly endIdle: (result: ImapResult<void>) => void;
  failNext: MailConnectionFailure | null;
};

const ACCOUNT: InboundAddress = {
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
    append: async () => ({ ok: true, value: undefined }),
    move: async () => ({ ok: true, value: undefined }),
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
    logout: async () => {
      client.logouts += 1;
      return { ok: true, value: undefined };
    },
  };

  // Expose hook used by connect mock.
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

  const createManager = (capabilities: readonly string[] = ['IDLE']) => {
    let connectCount = 0;
    return createLiveManager({
      now: () => nowMs,
      setTimer: setTimer as typeof setTimeout,
      clearTimer: clearTimer as typeof clearTimeout,
      connect: async (_imap, options) => {
        connectCount += 1;
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

  it('runs user tasks before background tasks', async () => {
    const manager = createManager();
    const order: string[] = [];
    const tasks = [
      manager.run(ACCOUNT, {
        priority: 'user',
        retry: true,
        run: async () => {
          order.push('u1');
          return { ok: true, value: 1 };
        },
      }),
      manager.run(ACCOUNT, {
        priority: 'background',
        retry: true,
        run: async () => {
          order.push('b1');
          return { ok: true, value: 2 };
        },
      }),
      manager.run(ACCOUNT, {
        priority: 'user',
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

  it('ensureSelected skips a second SELECT of the same mailbox', async () => {
    const manager = createManager();
    await manager.run(ACCOUNT, {
      priority: 'user',
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
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));

    let ran = false;
    const next = manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => {
        ran = true;
        expect(manager.state(ACCOUNT.address)).toMatchObject({ status: 'live', idling: false });
        return { ok: true, value: undefined };
      },
    });
    await next;
    expect(ran).toBe(true);
  });

  it('debounces exists during idle to one onMailboxChanged per second', async () => {
    const manager = createManager();
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    const client = clients[0];
    if (client === undefined) throw new Error('no client');
    client.emitUntagged({ kind: 'exists', count: 1 });
    client.emitUntagged({ kind: 'exists', count: 2 });
    client.emitUntagged({ kind: 'fetch', seq: 1, items: [] });
    expect(mailboxChanges).toEqual([ACCOUNT.address]);
    await advance(1000);
    client.emitUntagged({ kind: 'expunge', seq: 1 });
    expect(mailboxChanges).toEqual([ACCOUNT.address, ACCOUNT.address]);
  });

  it('retries a transport failure once when retry is true', async () => {
    const manager = createManager();
    let attempts = 0;
    const result = await manager.run(ACCOUNT, {
      priority: 'user',
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
    const result = await manager.run(ACCOUNT, {
      priority: 'user',
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

  it('setVisible(false) closes after 2 minutes; setVisible(true) cancels', async () => {
    const manager = createManager();
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    expect(clients[0]?.logouts ?? 0).toBe(0);

    manager.setVisible(false);
    await advance(60_000);
    expect(clients[0]?.logouts ?? 0).toBe(0);
    manager.setVisible(true);
    await advance(120_000);
    expect(clients[0]?.logouts ?? 0).toBe(0);

    manager.setVisible(false);
    await advance(120_000);
    await vi.waitFor(() => expect(manager.state(ACCOUNT.address)).toEqual({ status: 'closed' }));
    expect(clients[0]?.logouts).toBe(1);
  });

  it('closeAll LOGOUTs every connection and rejects queued tasks', async () => {
    const manager = createManager();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const running = manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => {
        await gate;
        return { ok: true, value: 'done' };
      },
    });
    const queued = manager.run(ACCOUNT, {
      priority: 'user',
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
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    const first = clients[0];
    if (first === undefined) throw new Error('no client');
    const changed: InboundAddress = {
      ...ACCOUNT,
      imap: { ...ACCOUNT.imap, password: 'new' },
    };
    await manager.run(changed, {
      priority: 'user',
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
    const running = manager.run(ACCOUNT, {
      priority: 'user',
      retry: false,
      run: async client => {
        await gate;
        // Still the first socket, still logged in: the LOGOUT must not have gone out yet.
        await client.append('Sent', new Uint8Array(), []);
        commandsAfterChange.push(clients[0]?.logouts ?? -1);
        return { ok: true, value: 'appended' };
      },
    });
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    const changed: InboundAddress = { ...ACCOUNT, imap: { ...ACCOUNT.imap, password: 'new' } };
    const next = manager.run(changed, {
      priority: 'user',
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
    const result = await manager.run(ACCOUNT, {
      priority: 'user',
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

    const twice = await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => {
        throw new Error('still boom');
      },
    });
    expect(twice).toEqual({ ok: false, error: { kind: 'error', detail: 'still boom' } });
    expect(manager.state(ACCOUNT.address)).toMatchObject({ status: 'failed' });
  });

  it('without IDLE, NOOPs every 5 min and onMailboxChanged every 2 min, without piling up', async () => {
    const manager = createManager([]);
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await flush();
    expect(clients[0]?.noops).toBe(0);
    await advance(2 * 60 * 1000);
    expect(mailboxChanges).toEqual([ACCOUNT.address]);
    await advance(3 * 60 * 1000);
    expect(clients[0]?.noops).toBe(1);
    // Ten minutes in: five polls and two NOOPs, not a growing chain of timers.
    await advance(5 * 60 * 1000);
    expect(mailboxChanges).toHaveLength(5);
    expect(clients[0]?.noops).toBe(2);
  });

  it("ignores a command's own EXISTS/FETCH responses; only an idling connection reports a change", async () => {
    const manager = createManager();
    await manager.run(ACCOUNT, {
      priority: 'user',
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
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    clients[0]?.emitUntagged({ kind: 'exists', count: 10 });
    expect(mailboxChanges).toEqual([ACCOUNT.address]);
  });

  it('reopens and idles again when the server drops an IDLE while visible', async () => {
    const manager = createManager();
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    clients[0]?.endIdle({ ok: false, reason: { kind: 'bye', text: 'Timeout' } });
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'live', idling: true }));
    expect(states.some(state => state.status === 'reconnecting')).toBe(true);
    // A second drop straight away is not chased: the state is failed until something asks.
    clients[1]?.endIdle({ ok: false, reason: { kind: 'bye', text: 'Timeout' } });
    await vi.waitFor(() => expect(states.at(-1)).toMatchObject({ status: 'failed' }));
    expect(clients).toHaveLength(2);
  });

  it('a transport failure that survives the retry marks the connection failed', async () => {
    const manager = createManager();
    const result = await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: false, error: { kind: 'imap', reason: { kind: 'closed' } } }),
    });
    expect(result.ok).toBe(false);
    expect(clients).toHaveLength(2);
    expect(manager.state(ACCOUNT.address)).toMatchObject({ status: 'failed' });
    expect(clients.map(client => client.logouts)).toEqual([1, 1]);
  });

  it('a manager created hidden closes its connections after the grace period', async () => {
    const manager = createLiveManager({
      now: () => nowMs,
      setTimer: setTimer as typeof setTimeout,
      clearTimer: clearTimer as typeof clearTimeout,
      visible: false,
      connect: async () => {
        const client = createFakeClient();
        clients.push(client);
        return {
          ok: true,
          value: { client, close: async () => void (await client.logout()), resumed: false },
        };
      },
      onState: (_address, state) => {
        states.push(state);
      },
      onMailboxChanged: () => {},
    });
    await manager.run(ACCOUNT, {
      priority: 'user',
      retry: true,
      run: async () => ({ ok: true, value: undefined }),
    });
    // Hidden: no IDLE, and the grace close is armed by the open itself — no event will arrive.
    expect(states.at(-1)).toMatchObject({ status: 'live', idling: false });
    await advance(2 * 60 * 1000);
    await vi.waitFor(() => expect(manager.state(ACCOUNT.address)).toEqual({ status: 'closed' }));
    expect(clients[0]?.logouts).toBe(1);
  });
});
