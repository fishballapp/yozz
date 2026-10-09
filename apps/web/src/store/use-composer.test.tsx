// @vitest-environment jsdom
import type { ImapMessageSummary } from '@yozz.app/imap';
import PostalMime from 'postal-mime';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundAddress } from '../addresses/record';
import type { DraftContent } from '../compose/draft';
import {
  claimSend,
  createDraft,
  listDrafts,
  replaceDraft,
  unconfirmSend,
} from '../compose/draft-vault';
import type { SentCopyFailure } from '../compose/send';
import type { Result } from '../relay/connection';
import { threadsFromAccounts } from '../threads/summaries';
import { isOnServer } from '../threads/thread';
import { fakeRecordStore } from '../vault/fake-record-store';
import type { RecordStore } from '../vault/record-store';
import { useComposerStore } from './use-composer';

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

// The network half of a send: what SMTP was handed (and whether it is still answering), and what
// the Sent APPEND answers (and whether it is still answering).
const network = vi.hoisted(() => ({
  submitted: [] as Uint8Array[],
  smtp: null as PromiseWithResolvers<void> | null,
  sentCopy: { ok: true, value: null } as Result<null, SentCopyFailure>,
  copying: null as Gate | null,
}));
vi.mock('../compose/send', async importOriginal => ({
  ...(await importOriginal<typeof import('../compose/send')>()),
  submitBytes: async (_identity: unknown, bytes: Uint8Array) => {
    network.submitted.push(bytes);
    await network.smtp?.promise;
    return { ok: true, value: undefined };
  },
  storeSentCopy: async () => {
    await network.copying?.pass();
    return network.sentCopy;
  },
}));

// This jsdom exposes no `localStorage`; the composer writes its device copy there.
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
});

const ACCOUNT: InboundAddress = {
  address: 'me@x.test',
  senderName: 'Me',
  smtp: { host: 'smtp.x', port: 465, username: 'me', password: 'p' },
  imap: { host: 'imap.x', port: 993, username: 'me', password: 'p' },
};

/** Whoever unlocks the same tab next. */
const OTHER: InboundAddress = { ...ACCOUNT, address: 'other@y.test' };

const content = (over: Partial<DraftContent> = {}): DraftContent => ({
  from: ACCOUNT.address,
  to: 'you@x.test',
  cc: '',
  bcc: '',
  subject: 'Plans',
  body: 'Hello',
  ...over,
});

/**
 * A vault whose draft writes can be held mid-flight, or fail as a dropped connection does, and
 * whose next read or next write can be held.
 */
const vaultOver = (store: RecordStore) => {
  let held: PromiseWithResolvers<void> | null = null;
  let nextRead: Gate | null = null;
  let nextPut: Gate | null = null;
  let isOffline = false;
  const gated: RecordStore = {
    ...store,
    list: async type => {
      const read = nextRead;
      nextRead = null;
      await read?.pass();
      return store.list(type);
    },
    put: async input => {
      const write = nextPut;
      nextPut = null;
      await write?.pass();
      await held?.promise;
      if (isOffline) throw new Error('network down');
      return store.put(input);
    },
  };
  return {
    store: gated,
    hold: () => {
      held = Promise.withResolvers();
    },
    release: () => held?.resolve(),
    holdNextRead: () => {
      nextRead = gate();
      return nextRead;
    },
    holdNextPut: () => {
      nextPut = gate();
      return nextPut;
    },
    goOffline: () => {
      isOffline = true;
    },
  };
};

type Props = Parameters<typeof useComposerStore>[0];

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  network.submitted.length = 0;
  network.smtp = null;
  network.sentCopy = { ok: true, value: null };
  network.copying = null;
  storage.clear();
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
});

/** The composer of a session over `store`, before its unlock has loaded anything. */
const render = async (store: RecordStore) => {
  const props: Props = {
    // Only the user id and the store are read; the keys behind them belong to the unlock.
    session: { userId: 'user-1', store } as unknown as Props['session'],
    identities: [ACCOUNT],
    accounts: [ACCOUNT],
    bindRunOn: () => () => async () => ({
      ok: false,
      error: { kind: 'error', detail: 'no IMAP here' },
    }),
    sync: async () => {},
    threadsRef: { current: [] },
    baseByAccount: {},
    demo: false,
  };
  const latest: { current: ReturnType<typeof useComposerStore> | null } = { current: null };
  const Probe = (probed: Props) => {
    latest.current = useComposerStore(probed);
    return null;
  };
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  await act(async () => root.render(<Probe {...props} />));
  const hook = () => {
    if (latest.current === null) throw new Error('the composer never rendered');
    return latest.current;
  };
  return {
    hook,
    rerender: (changes: Partial<Props>) =>
      act(async () => root.render(<Probe {...props} {...changes} />)),
  };
};

/** The composer of a session over `store`, unlocked. */
const mount = async (store: RecordStore) => {
  const rendered = await render(store);
  await act(() => rendered.hook().load(store, [ACCOUNT], () => false));
  return rendered;
};

type Mounted = Awaited<ReturnType<typeof mount>>;

/**
 * How a session ends under work still in flight, in the order the provider runs it: the render
 * without it, then the teardown's `reset`, then (on a sign-in) the next session's load. Each answers
 * with the drafts the next session should list.
 */
const SESSION_ENDINGS = {
  lock: async ({ rerender, hook }: Mounted) => {
    await rerender({ session: null });
    await act(async () => hook().reset('user-1'));
    return [];
  },
  'another account signing in': async ({ rerender, hook }: Mounted) => {
    const { store } = fakeRecordStore();
    const theirs = await createDraft(store, content({ from: OTHER.address, body: 'Theirs' }), 0);
    if (!theirs.ok) throw new Error('no draft for the next account');
    await rerender({
      session: { userId: 'user-2', store } as unknown as Props['session'],
      identities: [OTHER],
      accounts: [OTHER],
    });
    await act(async () => hook().reset('user-1'));
    await act(() => hook().load(store, [OTHER], () => false));
    return [theirs.handle];
  },
} satisfies Record<string, (mounted: Mounted) => Promise<unknown[]>>;

/** The copy IMAP lists once the APPEND lands: its envelope read off the bytes SMTP was handed. */
const serverCopyOf = async (bytes: Uint8Array): Promise<ImapMessageSummary> => {
  const mail = await PostalMime.parse(bytes);
  const [mailbox, host] = (mail.from?.address ?? '').split('@');
  return {
    seq: 1,
    uid: 42,
    flags: ['\\Seen'],
    internalDate: '01-Jan-2030 00:00:00 +0000',
    size: bytes.length,
    envelope: {
      // ENVELOPE carries the header verbatim.
      date: mail.headers.find(header => header.key === 'date')?.value ?? null,
      subject: mail.subject ?? null,
      subjectRaw: mail.subject ?? null,
      from: [{ name: mail.from?.name ?? null, mailbox: mailbox ?? null, host: host ?? null }],
      sender: [],
      replyTo: [],
      to: [],
      cc: [],
      bcc: [],
      inReplyTo: null,
      messageId: mail.messageId ?? null,
    },
    references: [],
    gmailThreadId: null,
  };
};

describe('discarding a draft from the Drafts list', () => {
  it('takes the row away before the vault answers, and tombstones the record', async () => {
    const vault = vaultOver(fakeRecordStore().store);
    const created = await createDraft(vault.store, content(), 0);
    if (!created.ok) throw new Error('no draft to discard');
    const { hook } = await mount(vault.store);
    expect(hook().shared.drafts.map(draft => draft.draftKey)).toEqual([created.handle.draftKey]);

    vault.hold();
    const { answer } = await act(async () => ({
      answer: hook().shared.removeDraft(created.handle.draftId),
    }));
    expect(hook().shared.drafts).toEqual([]);

    vault.release();
    await act(async () => expect(await answer).toMatchObject({ outcome: 'deleted' }));
    expect(hook().shared.drafts).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('puts the row back when the vault cannot be reached, and says so', async () => {
    const vault = vaultOver(fakeRecordStore().store);
    const created = await createDraft(vault.store, content(), 0);
    if (!created.ok) throw new Error('no draft to discard');
    const { hook } = await mount(vault.store);

    vault.goOffline();
    const outcome = await act(() => hook().shared.removeDraft(created.handle.draftId));
    expect(outcome).toEqual({ outcome: 'offline' });
    expect(hook().shared.drafts).toEqual([created.handle]);
  });
});

/** A draft the vault already holds, open in the composer: a Send goes straight to its claim. */
const openInComposer = async (body = 'Hello') => {
  const vault = vaultOver(fakeRecordStore().store);
  const created = await createDraft(vault.store, content({ body }), 0);
  if (!created.ok) throw new Error('no draft to open');
  const mounted = await mount(vault.store);
  await act(async () => {
    mounted.hook().composer.seedDraft(`draft:${created.handle.draftKey}`, {});
  });
  return { ...mounted, vault, created: created.handle };
};

describe('discarding the draft open in the composer', () => {
  it('lets go of it at once, and the tombstone lands after', async () => {
    const { hook, vault } = await openInComposer();
    vault.hold();
    const { discarded } = await act(async () => ({ discarded: hook().composer.discardDraft() }));
    expect(hook().shared.drafts).toEqual([]);

    vault.release();
    await act(async () => expect(await discarded).toMatchObject({ outcome: 'deleted' }));
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('still discards when its own autosave moved the record on first', async () => {
    const { hook, vault, created } = await openInComposer();
    // The autosave in flight when Discard was confirmed: the text on screen, one version on.
    await replaceDraft(vault.store, created.draftId, content(), 0);

    const outcome = await act(() => hook().composer.discardDraft());
    expect(outcome).toMatchObject({ outcome: 'deleted' });
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('keeps it when another device wrote something else since, and lists it again', async () => {
    const { hook, vault, created } = await openInComposer();
    await replaceDraft(vault.store, created.draftId, content({ body: 'Theirs' }), 0);

    const outcome = await act(() => hook().composer.discardDraft());
    expect(outcome).toMatchObject({ outcome: 'conflict' });
    expect(hook().shared.drafts.map(draft => draft.draftKey)).toEqual([created.draftKey]);
    expect((await listDrafts(vault.store)).map(draft => draft.record.body)).toEqual(['Theirs']);
  });
});

/** A new message written in the composer, with no record yet: its Send mints one first. */
const composeOne = async () => {
  const vault = vaultOver(fakeRecordStore().store);
  const mounted = await mount(vault.store);
  await act(async () => {
    mounted.hook().composer.seedDraft('new', {
      identityId: ACCOUNT.address,
      to: 'you@x.test',
      // Encoded on the wire, decoded by IMAP: the fingerprint must survive both.
      subject: 'Re: Café plans',
      body: 'See you there.',
    });
  });
  return { ...mounted, vault };
};

/** A send up to its claim: the composer has let go, and `settled` is the network half, still running. */
const claimOne = async () => {
  const mounted = await composeOne();
  const { settled } = await act(async () => {
    const claimed = await mounted.hook().composer.send();
    if (!claimed.ok) throw new Error('the send was refused at the claim');
    return { settled: claimed.value.settled };
  });
  return { ...mounted, settled };
};

describe('a message just sent from an address with a mailbox', () => {
  const sendOne = async () => {
    const { settled, ...mounted } = await claimOne();
    const report = await act(() => settled);
    const [bytes] = network.submitted;
    if (bytes === undefined) throw new Error('SMTP was never handed the message');
    return { ...mounted, report, bytes };
  };

  it('is in its conversation and in Sent before any sync, and nothing is left in Drafts', async () => {
    const { hook, report } = await sendOne();
    expect(report).toEqual({ state: 'sent' });
    expect(hook().shared.drafts).toEqual([]);
    const [thread] = threadsFromAccounts({}, hook().vaultSent);
    expect(thread?.folders).toEqual(['sent']);
    expect(thread?.messages.map(message => message.body)).toEqual([['See you there.']]);
  });

  it("collapses into the server's copy of the same bytes, then gives way to it", async () => {
    const { hook, rerender, bytes } = await sendOne();
    const synced = {
      [ACCOUNT.address]: { sent: { uidValidity: 7, summaries: [await serverCopyOf(bytes)] } },
    };

    // Both at once is one message, never two.
    const both = threadsFromAccounts(synced, hook().vaultSent);
    expect(both.flatMap(thread => thread.messages)).toHaveLength(1);

    await rerender({ baseByAccount: synced });
    expect(hook().vaultSent).toEqual([]);
  });

  it('stays until the vault locks when its Sent copy could not be stored', async () => {
    network.sentCopy = { ok: false, error: { kind: 'no-sent-mailbox' } };
    const { hook, rerender, report } = await sendOne();
    expect(report).toMatchObject({ state: 'sent-with-caveat' });

    await rerender({
      baseByAccount: { [ACCOUNT.address]: { sent: { uidValidity: 7, summaries: [] } } },
    });
    expect(hook().vaultSent).toHaveLength(1);
    // Nothing of it is on a server, so nothing offers to star, mark or file it.
    expect(threadsFromAccounts({}, hook().vaultSent).map(isOnServer)).toEqual([false]);

    await act(async () => hook().reset('user-1'));
    expect(hook().vaultSent).toEqual([]);
  });
});

describe('a send and the autosave it overtakes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets a send past its claim and through the network: it went out once, and Drafts kept nothing. */
  const sentOnce = async (
    { hook, vault }: Pick<Awaited<ReturnType<typeof composeOne>>, 'hook' | 'vault'>,
    claimed: ReturnType<ReturnType<typeof useComposerStore>['composer']['send']>,
  ) => {
    const answer = await act(() => claimed);
    if (!answer.ok) throw new Error('the send was refused at the claim');
    expect(await act(() => answer.value.settled)).toEqual({ state: 'sent' });
    expect(network.submitted).toHaveLength(1);
    expect(hook().shared.drafts).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);
  };

  it('mints one record when the debounce ends while the send is minting', async () => {
    const composed = await composeOne();
    const minting = composed.vault.holdNextPut();
    const { claimed } = await act(async () => ({ claimed: composed.hook().composer.send() }));
    await minting.reached;

    await act(async () => vi.advanceTimersByTime(2_000));
    minting.open();
    await sentOnce(composed, claimed);
  });

  it('claims the record its autosave is still minting', async () => {
    const composed = await composeOne();
    const minting = composed.vault.holdNextPut();
    await act(async () => vi.advanceTimersByTime(2_000));
    await minting.reached;

    const { claimed } = await act(async () => ({ claimed: composed.hook().composer.send() }));
    minting.open();
    await sentOnce(composed, claimed);
  });

  it('is not refused as edited elsewhere when the debounce ends under its claim', async () => {
    const opened = await openInComposer();
    await act(async () => opened.hook().composer.updateDraft({ body: 'Hello again' }));
    const claiming = opened.vault.holdNextPut();
    const { claimed } = await act(async () => ({ claimed: opened.hook().composer.send() }));
    await claiming.reached;

    await act(async () => vi.advanceTimersByTime(2_000));
    claiming.open();
    await sentOnce(opened, claimed);
  });
});

describe('a send and the close that overtakes it', () => {
  const close = ({ hook }: Pick<Mounted, 'hook'>) =>
    act(async () => {
      hook().composer.seedDraft(undefined, {});
    });

  it('mints one record when the composer closes while the send is minting', async () => {
    const composed = await composeOne();
    // Written into, so the close files it rather than dropping it.
    await act(async () => composed.hook().composer.updateDraft({ body: 'See you at noon.' }));
    const minting = composed.vault.holdNextPut();
    const { claimed } = await act(async () => ({ claimed: composed.hook().composer.send() }));
    await minting.reached;

    await close(composed);
    minting.open();
    const answer = await act(() => claimed);
    if (!answer.ok) throw new Error('the send was refused at the claim');
    expect(await act(() => answer.value.settled)).toEqual({ state: 'sent' });
    expect(network.submitted).toHaveLength(1);
    expect(composed.hook().shared.drafts).toEqual([]);
    expect(await listDrafts(composed.vault.store)).toEqual([]);
  });

  it('files nothing over the claim when the composer closes under it', async () => {
    const opened = await openInComposer();
    await act(async () => opened.hook().composer.updateDraft({ body: 'Hello again' }));
    const claiming = opened.vault.holdNextPut();
    const { claimed } = await act(async () => ({ claimed: opened.hook().composer.send() }));
    await claiming.reached;

    await close(opened);
    claiming.open();
    const answer = await act(() => claimed);
    if (!answer.ok) throw new Error('the send was refused at the claim');
    expect(await act(() => answer.value.settled)).toEqual({ state: 'sent' });
    expect(await listDrafts(opened.vault.store)).toEqual([]);
  });

  it("leaves the next session's device copy alone when its claim lands after a lock", async () => {
    const opened = await openInComposer();
    await act(async () => opened.hook().composer.updateDraft({ body: 'Hello again' }));
    const claiming = opened.vault.holdNextPut();
    const { claimed } = await act(async () => ({ claimed: opened.hook().composer.send() }));
    await claiming.reached;
    await close(opened);
    await SESSION_ENDINGS.lock(opened);

    // The same person unlocks again and starts writing something else.
    await opened.rerender({});
    await act(() => opened.hook().load(opened.vault.store, [ACCOUNT], () => false));
    await act(async () => {
      opened.hook().composer.seedDraft('new', { identityId: ACCOUNT.address, body: 'Next' });
    });
    expect(storage.has('yozz:draft:user-1')).toBe(true);

    claiming.open();
    const answer = await act(() => claimed);
    if (!answer.ok) throw new Error('the claim was refused');
    await act(() => answer.value.settled);
    expect(storage.get('yozz:draft:user-1')).toContain('Next');
  });
});

describe('an autosave refused as a conflict', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows its conflict in no compose opened since', async () => {
    const opened = await openInComposer();
    // Another device moves the record on, so this tab's next save is refused.
    await replaceDraft(opened.vault.store, opened.created.draftId, content({ body: 'Theirs' }), 0);
    await act(async () => opened.hook().composer.updateDraft({ body: 'Mine' }));
    const reread = opened.vault.holdNextRead();
    await act(async () => vi.advanceTimersByTime(2_000));
    await act(() => reread.reached);

    await act(async () => {
      opened.hook().composer.seedDraft(undefined, {});
    });
    await act(async () => {
      opened.hook().composer.seedDraft('new', { identityId: ACCOUNT.address });
    });
    reread.open();
    vi.useRealTimers();
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(opened.hook().shared.drafts.map(draft => draft.record.body)).toEqual(['Theirs']);
    expect(opened.hook().composer.draftConflict).toBeNull();
  });
});

describe('a first autosave still minting when its composer closes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the record the close files the newest text into', async () => {
    const composed = await composeOne();
    const minting = composed.vault.holdNextPut();
    await act(async () => vi.advanceTimersByTime(2_000));
    await minting.reached;
    await act(async () => composed.hook().composer.updateDraft({ body: 'See you at noon.' }));
    await act(async () => {
      composed.hook().composer.seedDraft(undefined, {});
    });

    minting.open();
    await act(() =>
      vi.waitFor(async () =>
        expect((await listDrafts(composed.vault.store)).map(draft => draft.record.body)).toEqual([
          'See you at noon.',
        ]),
      ),
    );
    expect(composed.hook().shared.drafts).toHaveLength(1);
  });

  it('names its record in no other compose', async () => {
    const composed = await composeOne();
    const minting = composed.vault.holdNextPut();
    await act(async () => vi.advanceTimersByTime(2_000));
    await minting.reached;
    await act(async () => {
      composed.hook().composer.seedDraft(undefined, {});
    });
    await act(async () => {
      composed.hook().composer.seedDraft('reply:<lunch@x.test>', {
        identityId: ACCOUNT.address,
        to: 'them@x.test',
        subject: 'Re: Lunch',
      });
    });

    minting.open();
    await act(() =>
      vi.waitFor(async () => expect(await listDrafts(composed.vault.store)).toHaveLength(1)),
    );
    const [minted] = await listDrafts(composed.vault.store);
    expect(minted?.record.subject).toBe('Re: Café plans');
    expect(composed.hook().composer.draft).toMatchObject({ subject: 'Re: Lunch' });
    expect(composed.hook().composer.draft?.draftKey).toBeUndefined();
    expect(composed.hook().shared.drafts.map(draft => draft.draftKey)).toEqual([minted?.draftKey]);
  });
});

describe('a write whose session ends before it reaches the vault', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['a send', ({ hook }: Mounted) => void hook().composer.send()],
    ['an autosave', () => vi.advanceTimersByTime(2_000)],
  ])('%s mints nothing when its session ends while it loads the vault', async (_, start) => {
    const mounted = await composeOne();
    await act(async () => {
      start(mounted);
      mounted.hook().reset('user-1');
    });

    vi.useRealTimers();
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(await listDrafts(mounted.vault.store)).toEqual([]);
  });
});

describe('an answer that lands after its session ended', () => {
  it.each(Object.entries(SESSION_ENDINGS))(
    'a send settling after %s shows none of it, and reports nothing',
    async (_, end) => {
      const smtp = Promise.withResolvers<void>();
      network.smtp = smtp;
      const mounted = await claimOne();
      const next = await end(mounted);

      smtp.resolve();
      expect(await act(() => mounted.settled)).toEqual({ state: 'ended' });
      expect(mounted.hook().vaultSent).toEqual([]);
      expect(mounted.hook().shared.drafts).toEqual(next);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'a discard refused after %s puts nothing back, and reports nothing',
    async (_, end) => {
      const vault = vaultOver(fakeRecordStore().store);
      const created = await createDraft(vault.store, content(), 0);
      if (!created.ok) throw new Error('no draft to discard');
      const mounted = await mount(vault.store);
      vault.hold();
      const { answer } = await act(async () => ({
        answer: mounted.hook().shared.removeDraft(created.handle.draftId),
      }));
      const next = await end(mounted);

      vault.goOffline();
      vault.release();
      expect(await act(() => answer)).toEqual({ outcome: 'ended' });
      expect(mounted.hook().shared.drafts).toEqual(next);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'a send whose claim lands after %s goes out once, and shows and reports nothing of it',
    async (_, end) => {
      const mounted = await openInComposer('See you there.');
      // What the composer takes before its own await on the claim.
      const isComposerCurrent = mounted.hook().shared.watchSession();
      mounted.vault.hold();
      const { claimed } = await act(async () => ({ claimed: mounted.hook().composer.send() }));
      const next = await end(mounted);

      mounted.vault.release();
      const answer = await act(() => claimed);
      if (!answer.ok) throw new Error('the claim was refused');
      expect(await act(() => answer.value.settled)).toEqual({ state: 'ended' });
      expect(network.submitted).toHaveLength(1);
      expect(isComposerCurrent()).toBe(false);
      expect(mounted.hook().vaultSent).toEqual([]);
      expect(mounted.hook().shared.sentCopyError).toBeNull();
      expect(mounted.hook().shared.drafts).toEqual(next);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'a send not yet claimed by %s claims nothing, so nothing goes out',
    async (_, end) => {
      const mounted = await composeOne();
      // Its record is still being minted.
      mounted.vault.hold();
      const { claimed } = await act(async () => ({ claimed: mounted.hook().composer.send() }));
      await end(mounted);

      mounted.vault.release();
      expect(await act(() => claimed)).toMatchObject({ ok: false });
      expect(network.submitted).toEqual([]);
      // Left as an ordinary draft in its owner's vault, for their next unlock.
      const kept = await listDrafts(mounted.vault.store);
      expect(kept.map(draft => draft.record.send)).toEqual([undefined]);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'the drafts an unlock lists after finishing its sends, read across %s, are not listed',
    async (_, end) => {
      const vault = vaultOver(fakeRecordStore().store);
      const beside = await createDraft(vault.store, content({ body: 'Not sent' }), 0);
      const sending = await createDraft(vault.store, content(), 0);
      if (!beside.ok || !sending.ok) throw new Error('no drafts to unlock');
      // Out through SMTP, but not yet in Sent: the unlock finishes it, then lists the drafts again.
      await claimSend(
        vault.store,
        sending.handle.draftId,
        {
          messageId: '<plans@x.test>',
          opId: 'op-1',
          state: 'submitted',
          claimedAt: 0,
          bytes: new TextEncoder().encode('Subject: Plans\r\n\r\nHello').toBase64(),
          target: { account: ACCOUNT.address, folder: 'sent' },
        },
        0,
      );
      const copying = gate();
      network.copying = copying;
      const mounted = await render(vault.store);
      let isCancelled = false;
      const { unlocked } = await act(async () => ({
        unlocked: mounted.hook().load(vault.store, [ACCOUNT], () => isCancelled),
      }));
      await act(() => copying.reached);
      const finalRead = vault.holdNextRead();
      copying.open();
      await act(() => finalRead.reached);
      // The provider's teardown cancels its load as the composer resets.
      isCancelled = true;
      const next = await end(mounted);

      finalRead.open();
      await act(() => unlocked);
      expect(mounted.hook().shared.drafts).toEqual(next);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'a draft the agent writes across %s is not listed, and the agent hears the session ended',
    async (_, end) => {
      const vault = vaultOver(fakeRecordStore().store);
      const mounted = await mount(vault.store);
      vault.hold();
      const { answer } = await act(async () => ({
        answer: mounted.hook().shared.writeDraft({ content: content() }),
      }));
      const next = await end(mounted);

      vault.release();
      expect(await act(() => answer)).toEqual({ ok: false, reason: 'ended' });
      expect(mounted.hook().shared.drafts).toEqual(next);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'a discard whose conflict re-read lands after %s writes nothing more',
    async (_, end) => {
      const opened = await openInComposer();
      const { vault, created, hook } = opened;
      // Its own autosave moved the record on, so the first tombstone is refused and re-read.
      await replaceDraft(vault.store, created.draftId, content(), 0);
      const reread = vault.holdNextRead();
      const { discarded } = await act(async () => ({ discarded: hook().composer.discardDraft() }));
      await act(() => reread.reached);
      await end(opened);

      reread.open();
      expect(await act(() => discarded)).toEqual({ outcome: 'ended' });
      expect(await listDrafts(vault.store)).toHaveLength(1);
    },
  );

  it.each(Object.entries(SESSION_ENDINGS))(
    'unconfirmed sends found in Sent across %s: the one under way finishes, no other starts',
    async (_, end) => {
      const vault = vaultOver(fakeRecordStore().store);
      const summaries: ImapMessageSummary[] = [];
      for (const subject of ['Plans', 'Lunch']) {
        const created = await createDraft(vault.store, content({ subject }), 0);
        if (!created.ok) throw new Error('no draft to send');
        const messageId = `<${subject.toLowerCase()}@x.test>`;
        const bytes = new TextEncoder().encode(
          `From: ${ACCOUNT.address}\r\nMessage-ID: ${messageId}\r\nSubject: ${subject}\r\n\r\nHi`,
        );
        const claimed = await claimSend(
          vault.store,
          created.handle.draftId,
          {
            messageId,
            opId: subject,
            state: 'submitting',
            claimedAt: 0,
            bytes: bytes.toBase64(),
            target: { account: ACCOUNT.address, folder: 'sent' },
          },
          0,
        );
        if (!claimed.ok) throw new Error('no claim to leave unconfirmed');
        await unconfirmSend(vault.store, claimed.handle.draftId);
        summaries.push(await serverCopyOf(bytes));
      }
      const mounted = await mount(vault.store);

      // Both turn up in Sent; the first completion's write is held.
      vault.hold();
      await mounted.rerender({
        baseByAccount: { [ACCOUNT.address]: { sent: { uidValidity: 7, summaries } } },
      });
      await end(mounted);

      vault.release();
      await act(() => new Promise(resolve => setTimeout(resolve, 20)));
      // The other is completed by the next unlock that finds it in Sent.
      expect(await listDrafts(vault.store)).toHaveLength(1);
    },
  );
});
