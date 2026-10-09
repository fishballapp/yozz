// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADDRESS_RECORD_TYPE, type AddressRecord } from '../addresses/record';
import { AgentTools } from '../agent/AgentTools';
import type { AgentTool } from '../agent/tools';
import { claimSend, createDraft, listDrafts } from '../compose/draft-vault';
// Loaded up front, so the work a test holds runs on as soon as it is let go, and so two sessions'
// first syncs never race the mocked module's factory into handing one of them the real sync.
import '../compose/send';
import '../compose/send-machine';
import '../threads/sync';
import { SENT_RECORD_TYPE } from '../compose/sent-record';
import type { ThreadState } from '../threads/thread';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import type { UnlockedVaultSession } from '../vault/unlock';
import { MailProvider, useComposer, useMail } from './MailProvider';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A point work stops at: `reached` once something waits there, which waits until `open`. */
type Gate = {
  readonly reached: Promise<void>;
  readonly open: () => void;
  readonly pass: () => Promise<void>;
};

const gate = (): Gate => {
  const reached = Promise.withResolvers<void>();
  const opened = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    open: () => opened.resolve(),
    pass: () => {
      reached.resolve();
      return opened.promise;
    },
  };
};

const mocks = vi.hoisted(() => ({
  session: null as Pick<UnlockedVaultSession, 'userId' | 'store'> | null,
  /** Counts live managers, one per session. */
  managers: 0,
  /** Every IMAP task that reached a manager: which session's, and for which address. */
  runs: [] as { manager: number; account: string }[],
  threads: [] as ThreadState[],
  /** Held SMTP: the send waits here before its `submitted` phase is written. */
  smtp: null as PromiseWithResolvers<void> | null,
  /** The next folder sync mark read waits here. */
  markRead: null as Gate | null,
  /** The next navigation waits here. */
  navigation: null as Gate | null,
  /** What a task that reaches a manager answers; refused as offline unless a test says otherwise. */
  answer: null as unknown,
  /** The next body written to the device cache waits here. */
  bodyWrite: null as Gate | null,
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => async () => {
    const held = mocks.navigation;
    mocks.navigation = null;
    await held?.pass();
  },
  useParams: () => ({}),
}));

vi.mock('../vault/session', () => ({ useVault: () => ({ session: mocks.session }) }));
vi.mock('../relay/live', () => ({
  createLiveManager: () => {
    mocks.managers += 1;
    const manager = mocks.managers;
    return {
      run: async (account: AddressRecord) => {
        mocks.runs.push({ manager, account: account.address });
        return mocks.answer ?? { ok: false, error: { kind: 'error', detail: 'offline' } };
      },
      close: async () => {},
      closeAll: async () => {},
      setVisible: () => {},
      state: () => ({ status: 'closed' }),
    };
  },
}));
vi.mock('../threads/cache', () => ({
  createMailCache: () => ({
    clear: async () => {},
    folder: () => ({
      getBody: async () => null,
      putBody: async () => {
        const write = mocks.bodyWrite;
        mocks.bodyWrite = null;
        await write?.pass();
      },
      listSummaries: async () => [],
      getSync: async () => {
        const read = mocks.markRead;
        mocks.markRead = null;
        await read?.pass();
        return { name: 'INBOX', uidValidity: 1, lastUid: 7, complete: true };
      },
    }),
  }),
  clearMailCache: async () => {},
}));
vi.mock('../threads/hydrate', () => ({
  cachedSummaries: async () => ({}),
  cachedPreviews: async () => ({}),
}));
// A sync that never lands and asks for no task, so every task a test sees is the one under test.
vi.mock('../threads/sync', async importOriginal => ({
  ...(await importOriginal<typeof import('../threads/sync')>()),
  syncAccount: () => new Promise(() => {}),
  prefetchBodies: () => {},
}));
vi.mock('../threads/summaries', async importOriginal => ({
  ...(await importOriginal<typeof import('../threads/summaries')>()),
  threadsFromAccounts: () => mocks.threads,
}));
vi.mock('../compose/send', async importOriginal => ({
  ...(await importOriginal<typeof import('../compose/send')>()),
  submitBytes: async () => {
    await mocks.smtp?.promise;
    return { ok: true, value: undefined };
  },
}));

// This jsdom exposes no `localStorage`; the composer writes its device copy there.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

/** Held by both sessions under the same servers: the case where a socket could be shared. */
const ALICE: AddressRecord = {
  address: 'alice@example.com',
  imap: { host: 'imap.example.com', port: 993, username: 'alice', password: 'pw' },
  smtp: { host: 'smtp.example.com', port: 465, username: 'alice', password: 'pw' },
};

/** The same address with no mailbox: its Sent copy is a vault record. */
const SEND_ONLY: AddressRecord = { address: ALICE.address, smtp: ALICE.smtp };

/** A vault holding one address, whose next write or next listing of one type can be held. */
const vault = async (address: AddressRecord = ALICE) => {
  const { store } = fakeRecordStore();
  await store.put({
    type: ADDRESS_RECORD_TYPE,
    naturalKey: address.address,
    plaintext: JSON.stringify(address),
  });
  let nextPut: Gate | null = null;
  const heldLists = new Map<string, Gate>();
  const gated: RecordStore = {
    ...store,
    put: async input => {
      const write = nextPut;
      nextPut = null;
      await write?.pass();
      return store.put(input);
    },
    list: async type => {
      const read = heldLists.get(type);
      heldLists.delete(type);
      await read?.pass();
      return store.list(type);
    },
  };
  return {
    store: gated,
    holdNextPut: () => {
      nextPut = gate();
      return nextPut;
    },
    holdNextList: (type: string) => {
      const read = gate();
      heldLists.set(type, read);
      return read;
    },
  };
};

const sendPhases = async (store: RecordStore) =>
  (await listDrafts(store)).map(draft => draft.record.send?.state);

/** A draft a closed tab left out through SMTP and not yet in Sent: the next unlock resumes it. */
const leaveSubmitted = async (
  store: RecordStore,
  target: 'vault' | 'mailbox',
  subject = 'Plans',
) => {
  const sending = await createDraft(
    store,
    { from: ALICE.address, to: 'bob@example.org', cc: '', bcc: '', subject, body: 'Hi' },
    0,
  );
  if (!sending.ok) throw new Error('no draft to unlock');
  await claimSend(
    store,
    sending.handle.draftId,
    {
      messageId: `<${subject.toLowerCase()}@example.com>`,
      opId: 'op-1',
      state: 'submitted',
      claimedAt: 0,
      bytes: new TextEncoder().encode('Subject: Plans\r\n\r\nHi').toBase64(),
      target: target === 'vault' ? 'vault' : { account: ALICE.address, folder: 'sent' },
    },
    0,
  );
};

/** Lets held work that was let go run as far as it can. */
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 20)));

const unmounts: (() => Promise<void>)[] = [];

const mount = async (store: RecordStore) => {
  mocks.session = { userId: 'user-1', store };
  let mail: ReturnType<typeof useMail> | null = null;
  let composer: ReturnType<typeof useComposer> | null = null;
  const Probe = () => {
    mail = useMail();
    composer = useComposer();
    return null;
  };
  const root = createRoot(document.createElement('div'));
  const render = () =>
    act(async () =>
      root.render(
        <MailProvider>
          <AgentTools />
          <Probe />
        </MailProvider>,
      ),
    );
  await render();
  unmounts.push(() => act(async () => root.unmount()));
  const current = () => {
    if (mail === null) throw new Error('MailProvider did not render');
    return mail;
  };
  await vi.waitFor(() => expect(current().identities).not.toHaveLength(0));
  return {
    mail: current,
    composer: () => {
      if (composer === null) throw new Error('Composer did not render');
      return composer;
    },
    /** A lock and unlock, or a sign-in as another account: the provider tears one session down for the next. */
    replaceSession: async (session: NonNullable<typeof mocks.session>) => {
      mocks.session = session;
      await render();
      await vi.waitFor(() => expect(current().identities).not.toHaveLength(0));
    },
  };
};

/** Another account signing in to the same tab, holding the same address on the same servers. */
const nextAccount = async () => ({ userId: 'user-2', store: (await vault()).store });

/** Unread in ALICE's inbox, so a session holding that address holds it too. */
const LUNCH: ThreadState = {
  id: 't1',
  accounts: [ALICE.address],
  subject: 'Lunch',
  isUnread: true,
  isReplied: false,
  isStarred: false,
  folders: ['inbox'],
  foldersByAccount: { [ALICE.address]: ['inbox'] },
  messages: [
    {
      id: 'm1',
      fromName: 'Bob',
      fromAddress: 'bob@example.org',
      toAddress: ALICE.address,
      at: 1,
      body: [],
      locations: [{ account: ALICE.address, folder: 'inbox', uidValidity: 1, uid: 7 }],
    },
  ],
};

/** The tools `AgentTools` registers once it mounts, as a browser agent would call them. */
const agentTools = () => {
  const registered: AgentTool[] = [];
  Object.defineProperty(document, 'modelContext', {
    value: {
      registerTool: async (tool: AgentTool) => {
        registered.push(tool);
      },
    },
    configurable: true,
  });
  return (name: string) => {
    const found = registered.find(tool => tool.name === name);
    if (found === undefined) throw new Error(`no tool ${name}`);
    return found;
  };
};

beforeEach(() => {
  mocks.managers = 0;
  mocks.runs.length = 0;
  mocks.threads = [];
  mocks.smtp = null;
  mocks.markRead = null;
  mocks.navigation = null;
  mocks.answer = null;
  mocks.bodyWrite = null;
  storage.clear();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  mocks.session = null;
  Reflect.deleteProperty(document, 'modelContext');
});

describe("an ended session's IMAP work", () => {
  it("a claimed send whose `submitted` write lands after the session ended never reaches the next session's connections", async () => {
    const theirs = await vault();
    const { composer, replaceSession } = await mount(theirs.store);
    await act(async () => {
      composer().seedDraft('new', {
        identityId: ALICE.address,
        to: 'bob@example.org',
        subject: 'Plans',
        body: 'See you there.',
      });
    });
    mocks.smtp = Promise.withResolvers();
    const { settled } = await act(async () => {
      const claimed = await composer().send();
      if (!claimed.ok) throw new Error('the send was refused at the claim');
      return { settled: claimed.value.settled };
    });
    const advance = theirs.holdNextPut();
    mocks.smtp.resolve();
    await act(() => advance.reached);

    await replaceSession(await nextAccount());
    advance.open();
    expect(await act(() => settled)).toEqual({ state: 'ended' });
    expect(mocks.runs).toEqual([]);

    // Out through SMTP and recorded as such, so the next unlock of that vault stores its copy.
    expect(await sendPhases(theirs.store)).toEqual(['submitted']);
    await replaceSession({ userId: 'user-1', store: theirs.store });
    await vi.waitFor(() => expect(mocks.runs).toEqual([{ manager: 3, account: ALICE.address }]));
  });

  it("an unlock whose Sent-record read lands after the session ended resumes nothing into the next session's", async () => {
    const theirs = await vault();
    await leaveSubmitted(theirs.store, 'mailbox');
    const sentRead = theirs.holdNextList(SENT_RECORD_TYPE);
    const { replaceSession } = await mount(theirs.store);
    await act(() => sentRead.reached);

    await replaceSession(await nextAccount());
    sentRead.open();
    await settle();
    expect(mocks.runs).toEqual([]);

    expect(await sendPhases(theirs.store)).toEqual(['submitted']);
    await replaceSession({ userId: 'user-1', store: theirs.store });
    await vi.waitFor(() => expect(mocks.runs).toEqual([{ manager: 3, account: ALICE.address }]));
  });

  it('an unlock whose Sent-record read lands after the session ended finishes no send; the next unlock does', async () => {
    const theirs = await vault(SEND_ONLY);
    await leaveSubmitted(theirs.store, 'vault');
    const sentRead = theirs.holdNextList(SENT_RECORD_TYPE);
    const { replaceSession } = await mount(theirs.store);
    await act(() => sentRead.reached);

    await replaceSession(await nextAccount());
    sentRead.open();
    await settle();
    expect(await sendPhases(theirs.store)).toEqual(['submitted']);

    await replaceSession({ userId: 'user-1', store: theirs.store });
    await vi.waitFor(async () => expect(await sendPhases(theirs.store)).toEqual([]));
  });

  it('an unlock that ended under one resumed send starts no other', async () => {
    const theirs = await vault(SEND_ONLY);
    await leaveSubmitted(theirs.store, 'vault', 'Plans');
    await leaveSubmitted(theirs.store, 'vault', 'Lunch');
    // The first resumed send's Sent record.
    const sentWrite = theirs.holdNextPut();
    const { replaceSession } = await mount(theirs.store);
    await act(() => sentWrite.reached);

    await replaceSession(await nextAccount());
    sentWrite.open();
    await settle();
    // The one under way finished; the other waits for the next unlock of that vault.
    expect(await sendPhases(theirs.store)).toEqual(['submitted']);
  });

  it("a flag write whose folder read lands after the session ended never reaches the next session's connections", async () => {
    mocks.threads = [LUNCH];
    const { mail, replaceSession } = await mount((await vault()).store);
    const folderRead = gate();
    mocks.markRead = folderRead;
    act(() => {
      mail().markRead('t1');
    });
    await act(() => folderRead.reached);

    await replaceSession(await nextAccount());
    folderRead.open();
    await settle();
    expect(mocks.runs).toEqual([]);
  });

  it("an agent's navigation that lands after the session ended marks nothing read over the next session's connections", async () => {
    mocks.threads = [LUNCH];
    const tool = agentTools();
    const { replaceSession } = await mount((await vault()).store);
    const navigation = gate();
    mocks.navigation = navigation;
    const opened = tool('navigate').execute({ target: 'thread', threadId: 't1' });
    await act(() => navigation.reached);

    await replaceSession(await nextAccount());
    navigation.open();
    expect(await act(() => opened)).toEqual({ error: expect.stringContaining('locked') });
    await settle();
    expect(mocks.runs).toEqual([]);
  });
});

/** Another address of the first account's: stored by it, never held by the next. */
const WORK: AddressRecord = {
  address: 'alice@work.example',
  imap: { host: 'imap.work.example', port: 993, username: 'alice', password: 'work-pw' },
  smtp: { host: 'smtp.work.example', port: 465, username: 'alice', password: 'work-pw' },
};

describe("an ended session's answers", () => {
  it('an address whose vault write lands after the session ended joins nothing in the next one', async () => {
    const theirs = await vault();
    const { mail, replaceSession } = await mount(theirs.store);
    const write = theirs.holdNextPut();
    const put = mail().putAddress(WORK);
    await act(() => write.reached);

    await replaceSession(await nextAccount());
    write.open();
    await act(() => put);
    expect(mail().identities.map(record => record.address)).toEqual([ALICE.address]);

    // Stored where it was typed, so that vault's next unlock lists it.
    const stored = await theirs.store.list(ADDRESS_RECORD_TYPE);
    expect(stored.map(row => row.naturalKey)).toContain(WORK.address);
  });

  it("a body whose cache write lands after the session ended is shown in nobody else's thread", async () => {
    const [message] = LUNCH.messages;
    if (message === undefined) throw new Error('no message');
    mocks.threads = [{ ...LUNCH, messages: [{ ...message, bodyStatus: 'pending', rawSize: 64 }] }];
    mocks.answer = {
      ok: true,
      value: {
        paragraphs: ['The code is 4417.'],
        html: null,
        hasTextPart: true,
        inlineImagesTruncated: false,
        attachments: [],
      },
    };
    const { mail, replaceSession } = await mount((await vault()).store);
    const bodyWrite = gate();
    mocks.bodyWrite = bodyWrite;
    const loaded = mail().loadBody('t1', 'm1');
    await act(() => bodyWrite.reached);

    await replaceSession(await nextAccount());
    bodyWrite.open();
    expect(await act(() => loaded)).toEqual({ status: 'failed' });
    expect(mail().threads[0]?.messages[0]?.body).toEqual([]);
  });

  it("an older page that lands after the session ended leaves the next session's page loading", async () => {
    const { mail, replaceSession } = await mount((await vault()).store);
    const theirPage = gate();
    mocks.markRead = theirPage;
    act(() => {
      void mail().loadOlder(ALICE.address);
    });
    await act(() => theirPage.reached);

    await replaceSession(await nextAccount());
    const ourPage = gate();
    mocks.markRead = ourPage;
    act(() => {
      void mail().loadOlder(ALICE.address);
    });
    await act(() => ourPage.reached);
    theirPage.open();
    await settle();
    expect(mail().isLoadingOlder(ALICE.address)).toBe(true);

    ourPage.open();
    await settle();
    expect(mail().isLoadingOlder(ALICE.address)).toBe(false);
  });
});
