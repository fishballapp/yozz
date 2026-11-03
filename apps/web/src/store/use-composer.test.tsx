// @vitest-environment jsdom
import type { ImapMessageSummary } from '@yozz.app/imap';
import type { InboundAddress } from '@yozz.app/mail/addresses/record';
import { contentOf, type DraftContent } from '@yozz.app/mail/compose/draft';
import { SEND_LEASE_RECORD_TYPE } from '@yozz.app/mail/compose/draft-record';
import {
  claimSend,
  completeSend,
  createDraft,
  deleteDraft,
  listDrafts,
  reclaimSend,
  replaceDraft,
  unconfirmSend,
} from '@yozz.app/mail/compose/draft-vault';
import type { SentCopyFailure } from '@yozz.app/mail/compose/send';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { fakeFileStore } from '@yozz.app/mail/testing/fake-file-store';
import { fakeRecordStore } from '@yozz.app/mail/testing/fake-record-store';
import { threadsFromAccounts } from '@yozz.app/mail/threads/summaries';
import { isOnServer } from '@yozz.app/mail/threads/thread';
import { VaultApiError } from '@yozz.app/mail/vault/api';
import type { FileStore } from '@yozz.app/mail/vault/file-store';
import type { RecordStore } from '@yozz.app/mail/vault/record-store';
import PostalMime from 'postal-mime';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActivityTracker, isUnsavedWork } from '../relay/activity';
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
  submitAnswer: { ok: true, value: undefined } as Result<void, MailConnectionFailure>,
  sentCopy: { ok: true, value: null } as Result<null, SentCopyFailure>,
  copying: null as Gate | null,
}));
vi.mock('../compose/submit', () => ({
  submitBytes: async (_identity: unknown, bytes: Uint8Array) => {
    network.submitted.push(bytes);
    await network.smtp?.promise;
    return network.submitAnswer;
  },
}));
vi.mock('@yozz.app/mail/compose/send', async importOriginal => ({
  ...(await importOriginal<typeof import('@yozz.app/mail/compose/send')>()),
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
  network.submitAnswer = { ok: true, value: undefined };
  network.sentCopy = { ok: true, value: null };
  network.copying = null;
  storage.clear();
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
});

/** The composer of a session over `store`, before its unlock has loaded anything. */
const storesOf = (store: RecordStore) => ({ store, files: fakeFileStore().store });

const render = async (store: RecordStore, files: FileStore = fakeFileStore().store) => {
  const activity = createActivityTracker();
  const props: Props = {
    // Only the user id and the stores are read; the keys behind them belong to the unlock.
    session: { userId: 'user-1', store, files } as unknown as Props['session'],
    identities: [ACCOUNT],
    accounts: [ACCOUNT],
    bindRunOn: () => () => async () => ({
      ok: false,
      error: { kind: 'error', detail: 'no IMAP here' },
    }),
    currentAccount: address => (address === ACCOUNT.address ? ACCOUNT : undefined),
    sync: async () => {},
    threadsRef: { current: [] },
    baseByAccount: {},
    activity,
    demo: false,
  };
  const latest: { current: ReturnType<typeof useComposerStore> | null } = { current: null };
  const composers: ReturnType<typeof useComposerStore>['composer'][] = [];
  const Probe = (probed: Props) => {
    latest.current = useComposerStore(probed);
    composers.push(latest.current.composer);
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
    activity,
    /** What every render handed out, in order. */
    composers,
    rerender: (changes: Partial<Props>) =>
      act(async () => root.render(<Probe {...props} {...changes} />)),
  };
};

/** The composer of a session over `store`, unlocked. */
const mount = async (store: RecordStore, files: FileStore = fakeFileStore().store) => {
  const rendered = await render(store, files);
  await act(() => rendered.hook().load(storesOf(store), [ACCOUNT], () => false));
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
      session: {
        userId: 'user-2',
        store,
        files: fakeFileStore().store,
      } as unknown as Props['session'],
      identities: [OTHER],
      accounts: [OTHER],
    });
    await act(async () => hook().reset('user-1'));
    await act(() => hook().load(storesOf(store), [OTHER], () => false));
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

describe("a draft's files", () => {
  const FILE_BYTES = new Uint8Array([1, 2, 3]);
  const picked = {
    name: 'receipt.pdf',
    size: 3,
    kind: 'pdf' as const,
    mimeType: 'application/pdf',
    content: FILE_BYTES,
  };

  /** A composer with a message written, over a file store whose uploads a test can hold or refuse. */
  const composeWithFiles = async (over: Partial<FileStore> = {}) => {
    const vault = vaultOver(fakeRecordStore().store);
    const { store: real, files: stored } = fakeFileStore();
    const reads: string[] = [];
    const files: FileStore = {
      ...real,
      get: async fileId => {
        reads.push(fileId);
        return real.get(fileId);
      },
      ...over,
    };
    const mounted = await mount(vault.store, files);
    await act(async () => {
      mounted.hook().composer.seedDraft('new', {
        identityId: ACCOUNT.address,
        to: 'you@x.test',
        subject: 'Receipt',
        body: 'Attached.',
      });
    });
    return { ...mounted, vault, files, stored, reads };
  };

  const sendNow = async ({ hook }: { hook: () => ReturnType<typeof useComposerStore> }) => {
    const claimed = await act(() => hook().composer.send());
    if (!claimed.ok) return claimed;
    return { ...claimed, report: await act(() => claimed.value.settled) };
  };

  it('uploads a file the moment it is attached, and only then names it', async () => {
    const held = gate();
    const { hook } = await composeWithFiles({
      put: async () => {
        await held.pass();
      },
    });
    await act(async () => hook().composer.attach([picked]));

    const draft = hook().composer.draft;
    expect(draft?.attachments[0]).toMatchObject({ name: 'receipt.pdf', upload: 'uploading' });
    // What a save writes: a file still on its way is named nowhere.
    if (draft === null || draft === undefined) throw new Error('no draft');
    expect(contentOf(draft, undefined).attachments).toEqual([]);
    await held.reached;
    await act(async () => held.open());
    await act(async () => {});
    const uploaded = hook().composer.draft;
    if (uploaded === null) throw new Error('no draft');
    expect(contentOf(uploaded, undefined).attachments).toMatchObject([{ name: 'receipt.pdf' }]);
  });

  it('counts an upload as work a reload would lose, until it settles', async () => {
    const held = gate();
    const { hook, activity } = await composeWithFiles({
      put: async () => {
        await held.pass();
      },
    });

    await act(async () => hook().composer.attach([picked]));

    expect(activity.snapshot().filter(isUnsavedWork)).toHaveLength(1);
    await held.reached;
    await act(async () => held.open());
    expect(activity.snapshot()).toEqual([]);
  });

  it('stops counting an upload that failed', async () => {
    const { hook, activity } = await composeWithFiles({
      put: async () => {
        throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    });

    await act(async () => hook().composer.attach([picked]));

    expect(hook().composer.draft?.attachments[0]?.upload).toBe('failed');
    expect(activity.snapshot()).toEqual([]);
  });

  it('sends from the bytes it holds, downloading nothing it just uploaded', async () => {
    const world = await composeWithFiles();
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});

    const sent = await sendNow(world);

    expect(sent).toMatchObject({ report: { state: 'sent' } });
    expect(world.reads).toEqual([]);
    const raw = new TextDecoder().decode(network.submitted[0]);
    expect(raw).toContain('filename="receipt.pdf"');
    expect(raw).toContain('AQID');
  });

  it('waits for an upload under way, then sends with it', async () => {
    const held = gate();
    const { store: real } = fakeFileStore();
    const world = await composeWithFiles({
      put: async (fileId, bytes) => {
        await held.pass();
        await real.put(fileId, bytes);
      },
    });
    await act(async () => world.hook().composer.attach([picked]));

    const pending = world.hook().composer.send();
    await held.reached;
    expect(network.submitted).toEqual([]);
    await act(async () => held.open());
    const claimed = await act(() => pending);
    if (!claimed.ok) throw new Error('refused');
    await act(() => claimed.value.settled);

    expect(new TextDecoder().decode(network.submitted[0])).toContain('AQID');
  });

  it('refuses to send over a failed upload, before anything is claimed', async () => {
    const world = await composeWithFiles({
      put: async () => {
        throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    });
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});
    expect(world.hook().composer.draft?.attachments[0]?.upload).toBe('failed');

    expect(await sendNow(world)).toEqual({
      ok: false,
      error: {
        kind: 'error',
        detail: 'receipt.pdf failed to upload. Retry or remove it before sending.',
      },
    });
    expect(network.submitted).toEqual([]);
    expect(await listDrafts(world.vault.store)).toEqual([]);
  });

  it('says storage is full apart from any other failed upload', async () => {
    const world = await composeWithFiles({
      put: async () => {
        throw new VaultApiError('STORAGE_FULL', 'File storage is full', 413);
      },
    });
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});
    expect(world.hook().composer.draft?.attachments[0]?.upload).toBe('storage-full');
  });

  it('retries under a new id, leaving the old attempt to collection', async () => {
    const ids: string[] = [];
    let isDown = true;
    const world = await composeWithFiles({
      put: async fileId => {
        ids.push(fileId);
        if (isDown) throw new VaultApiError('NETWORK_ERROR', 'offline');
      },
    });
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});
    isDown = false;
    const failed = world.hook().composer.draft?.attachments[0];
    if (failed === undefined) throw new Error('no file on the draft');

    await act(async () => world.hook().composer.retryUpload(failed.id));
    await act(async () => {});

    const [retried] = world.hook().composer.draft?.attachments ?? [];
    expect(retried?.upload).toBe('uploaded');
    expect(retried?.id).not.toBe(failed.id);
    expect(ids).toEqual([failed.id, retried?.id]);
  });

  it('keeps the file a device-stored draft named, so a reload still has it', async () => {
    const world = await composeWithFiles();
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});
    await act(async () => {
      world.hook().composer.seedDraft(undefined, {});
    });
    const [saved] = await listDrafts(world.vault.store);
    expect(saved?.record.attachments).toMatchObject([{ name: 'receipt.pdf', size: 3 }]);
    // The bytes never reach the record.
    expect(saved?.record.attachments?.[0]).not.toHaveProperty('content');
  });

  it('files a closed draft with the upload that was still running', async () => {
    const held = gate();
    const { store: real } = fakeFileStore();
    const world = await composeWithFiles({
      put: async (fileId, bytes) => {
        await held.pass();
        await real.put(fileId, bytes);
      },
    });
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {
      world.hook().composer.seedDraft(undefined, {});
    });
    expect(await listDrafts(world.vault.store)).toEqual([]);

    await held.reached;
    await act(async () => held.open());
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));

    const [filed] = await listDrafts(world.vault.store);
    expect(filed?.record.attachments).toMatchObject([{ name: 'receipt.pdf' }]);
  });

  it("uploads a forwarded message's files as it opens, and names again what R2 already holds", async () => {
    const world = await composeWithFiles();
    await act(async () => {
      world.hook().composer.seedDraft('forward:mid/<m@x.test>', {
        identityId: ACCOUNT.address,
        subject: 'Fwd: Receipt',
        attachments: [
          picked,
          { name: 'copy.pdf', size: 3, kind: 'pdf', fileId: 'held-1' },
          { name: 'lost.pdf', size: 3, kind: 'pdf' },
        ],
      });
    });
    await act(async () => {});

    expect(world.hook().composer.draft?.attachments).toMatchObject([
      { name: 'receipt.pdf', upload: 'uploaded' },
      { id: 'held-1', name: 'copy.pdf', upload: 'uploaded' },
      // No bytes to send and none to fetch: the person is told, rather than sending without it.
      { name: 'lost.pdf', upload: 'failed' },
    ]);
    expect(world.stored.size).toBe(1);
  });

  it('opens a draft another device attached to with its chips, and reads R2 only to send', async () => {
    const { store: real, files: stored } = fakeFileStore();
    const reads: string[] = [];
    const vault = vaultOver(fakeRecordStore().store);
    await real.put('file-1', FILE_BYTES);
    const created = await createDraft(
      vault.store,
      content({ attachments: [{ id: 'file-1', name: 'receipt.pdf', size: 3, kind: 'pdf' }] }),
      0,
    );
    if (!created.ok) throw new Error('no draft');
    const mounted = await mount(vault.store, {
      ...real,
      get: async fileId => {
        reads.push(fileId);
        return real.get(fileId);
      },
    });
    await act(async () => {
      mounted.hook().composer.seedDraft(`draft:${created.handle.draftKey}`, {});
    });

    expect(mounted.hook().composer.draft?.attachments).toMatchObject([
      { id: 'file-1', name: 'receipt.pdf', upload: 'uploaded' },
    ]);
    expect(reads).toEqual([]);
    expect(stored.size).toBe(1);

    const sent = await sendNow(mounted);

    expect(sent).toMatchObject({ report: { state: 'sent' } });
    expect(reads).toEqual(['file-1']);
    expect(new TextDecoder().decode(network.submitted[0])).toContain('AQID');
  });

  it('gives the draft back when another device cannot read the file before SMTP', async () => {
    const vault = vaultOver(fakeRecordStore().store);
    const created = await createDraft(
      vault.store,
      content({ attachments: [{ id: 'gone', name: 'receipt.pdf', size: 3, kind: 'pdf' }] }),
      0,
    );
    if (!created.ok) throw new Error('no draft');
    const mounted = await mount(vault.store);
    await act(async () => {
      mounted.hook().composer.seedDraft(`draft:${created.handle.draftKey}`, {});
    });

    const sent = await sendNow(mounted);

    expect(sent).toMatchObject({
      report: {
        state: 'refused',
        detail: 'Couldn’t download receipt.pdf. Reopen the draft and try again.',
      },
    });
    expect(network.submitted).toEqual([]);
    const [back] = await listDrafts(vault.store);
    expect(back?.record.send).toBeUndefined();
    expect(back?.record.attachments).toHaveLength(1);
  });

  it('never tells anyone to reopen a message that went out, when only its copy failed', async () => {
    network.sentCopy = {
      ok: false,
      error: { kind: 'error', detail: 'Couldn’t download receipt.pdf' },
    };
    const world = await composeWithFiles();
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});

    expect(await sendNow(world)).toMatchObject({
      report: {
        state: 'sent-with-caveat',
        detail: 'the copy was not stored · Couldn’t download receipt.pdf',
      },
    });
  });

  it.each([
    ['the server went quiet', { kind: 'stalled' }],
    ['the connection dropped', { kind: 'imap', reason: { kind: 'closed' } }],
  ] as const)('does not claim the copy is missing when %s', async (_label, error) => {
    network.sentCopy = { ok: false, error };
    const world = await composeWithFiles();
    await act(async () => world.hook().composer.attach([picked]));
    await act(async () => {});

    const sent = await sendNow(world);
    expect(sent).toMatchObject({ report: { state: 'sent-with-caveat' } });
    expect(sent).toMatchObject({
      report: { detail: expect.stringContaining('may still appear') },
    });
  });

  it('adds no instruction to a refusal that was not about a file', async () => {
    network.submitAnswer = { ok: false, error: { kind: 'error', detail: 'refused by the host' } };
    const world = await composeWithFiles();

    expect(await sendNow(world)).toMatchObject({
      report: { state: 'refused', detail: 'refused by the host' },
    });
  });

  it('files nothing for a forward nobody touched, and waits on none of its uploads', async () => {
    const held = gate();
    const world = await composeWithFiles({
      put: async () => {
        await held.pass();
      },
    });
    await act(async () => {
      world.hook().composer.seedDraft('forward:mid/<m@x.test>', {
        identityId: ACCOUNT.address,
        subject: 'Fwd: Receipt',
        body: 'quoted',
        attachments: [picked],
      });
    });

    await act(async () => {
      world.hook().composer.seedDraft(undefined, {});
    });
    await held.reached;
    await act(async () => held.open());
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));

    expect(await listDrafts(world.vault.store)).toEqual([]);
  });

  describe('a Send and the writes around it', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const second = { ...picked, name: 'second.pdf' };
    const debounce = () => act(async () => vi.advanceTimersByTime(2_000));

    it('writes nothing while it waits on uploads, then claims the version it read', async () => {
      const gates = [gate(), gate()];
      let uploads = 0;
      const world = await composeWithFiles({
        put: async () => {
          const held = gates[uploads];
          uploads += 1;
          await held?.pass();
        },
      });
      await debounce();
      expect((await listDrafts(world.vault.store))[0]?.record.contentVersion).toBe(1);
      await act(async () => world.hook().composer.attach([picked, second]));

      const pending = world.hook().composer.send();
      // One upload settling changes the draft, which is what used to re-arm the autosave.
      await act(async () => gates[0]?.open());
      await debounce();

      expect((await listDrafts(world.vault.store))[0]?.record.contentVersion).toBe(1);
      await act(async () => gates[1]?.open());
      const claimed = await act(() => pending);
      if (!claimed.ok) throw new Error(`refused: ${JSON.stringify(claimed.error)}`);
      await act(() => claimed.value.settled);
      const raw = new TextDecoder().decode(network.submitted[0]);
      expect(raw).toContain('filename="receipt.pdf"');
      expect(raw).toContain('filename="second.pdf"');
    });

    it('waits for a save already under way, and claims the version it wrote', async () => {
      const world = await composeWithFiles();
      await debounce();
      await act(async () => world.hook().composer.updateDraft({ body: 'Newer.' }));
      const saving = world.vault.holdNextPut();
      await debounce();
      await saving.reached;

      const pending = world.hook().composer.send();
      // Far enough that a Send not waiting would have claimed by now.
      await act(async () => {
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(network.submitted).toEqual([]);
      expect((await listDrafts(world.vault.store))[0]?.record.send).toBeUndefined();

      // Inside one `act`, so no render has told the draft about the version the save wrote.
      const claimed = await act(async () => {
        saving.open();
        return pending;
      });

      expect(claimed.ok).toBe(true);
    });

    it('saves again once a refused Send lets go, what was typed included', async () => {
      const world = await composeWithFiles({
        put: async () => {
          throw new VaultApiError('NETWORK_ERROR', 'offline');
        },
      });
      await act(async () => world.hook().composer.attach([picked]));
      await act(async () => world.hook().composer.updateDraft({ body: 'Typed before Send.' }));

      expect(await sendNow(world)).toMatchObject({ ok: false });
      expect(await listDrafts(world.vault.store)).toEqual([]);
      await debounce();

      const [saved] = await listDrafts(world.vault.store);
      expect(saved?.record.body).toBe('Typed before Send.');
    });
  });

  it('refuses text too long to send, with a sentence of its own, before the claim', async () => {
    const world = await composeWithFiles();
    await act(async () => {
      world.hook().composer.updateDraft({ body: 'x '.repeat(200_000) });
    });

    expect(await sendNow(world)).toEqual({
      ok: false,
      error: {
        kind: 'error',
        detail: 'This message’s text is too long to send. Shorten it or trim the quoted thread.',
      },
    });
    expect(network.submitted).toEqual([]);
    const [draft] = await listDrafts(world.vault.store);
    expect(draft?.record.send).toBeUndefined();
  });
});

describe('an unlock that finishes a send-only message', () => {
  it('shows it in Sent at once, not after the next reload', async () => {
    const vault = vaultOver(fakeRecordStore().store);
    const created = await createDraft(vault.store, content(), 0);
    if (!created.ok) throw new Error('no draft');
    await claimSend(vault.store, created.handle.draftId, {
      messageId: '<plans@x.test>',
      opId: 'op-1',
      state: 'submitted',
      claimedAt: 0,
      message: {
        head: new TextEncoder().encode('Date: x\r\nSubject: Plans\r\n\r\nHello').toBase64(),
        splices: [],
      },
      target: 'vault',
    });

    const { hook } = await mount(vault.store);

    expect(hook().vaultSent.map(({ messageId }) => messageId)).toEqual(['<plans@x.test>']);
    expect(hook().shared.drafts).toEqual([]);
  });
});

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

  it("finishes with no Sent folder, keeping the toast and this tab's own copy until lock", async () => {
    network.sentCopy = { ok: false, error: { kind: 'no-sent-mailbox' } };
    const { hook, rerender, report, vault } = await sendOne();
    expect(report).toEqual({
      state: 'sent-with-caveat',
      detail: 'imap.x has no Sent folder to keep a copy in',
    });
    expect(hook().shared.sentCopyError).toBe(
      'sent, but imap.x has no Sent folder to keep a copy in',
    );
    expect(hook().shared.drafts).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);

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

describe('a message whose SMTP answer was lost after its end', () => {
  const sendLost = async () => {
    network.submitAnswer = {
      ok: false,
      error: { kind: 'smtp', reason: { kind: 'unconfirmed', detail: 'connection closed' } },
    };
    const { settled, ...mounted } = await claimOne();
    const report = await act(() => settled);
    const [bytes] = network.submitted;
    const [draft] = mounted.hook().shared.drafts;
    if (bytes === undefined || draft === undefined) {
      throw new Error('the send left nothing to open');
    }
    return { ...mounted, report, bytes, draft };
  };

  /** What the composer shows for a draft opened from Drafts. */
  const reopen = async ({ hook }: Mounted, draftKey: string) => {
    await act(async () => {
      hook().composer.seedDraft(`draft:${draftKey}`, {});
    });
    const { openSendState, isOpenDraftFrozen } = hook().composer;
    return { openSendState, isOpenDraftFrozen };
  };

  const SETTLE = { openSendState: 'unconfirmed', isOpenDraftFrozen: true };

  it('offers to settle it as soon as the draft is opened again, frozen until then', async () => {
    const lost = await sendLost();
    expect(lost.report).toMatchObject({ state: 'unsettled' });
    // The tab holds the version that says so, not the one from before the claim.
    expect(lost.draft.record.send?.state).toBe('unconfirmed');
    expect(await reopen(lost, lost.draft.draftKey)).toEqual(SETTLE);

    // And after a reload, from the vault alone.
    const reloaded = await mount(lost.vault.store);
    expect(await reopen(reloaded, lost.draft.draftKey)).toEqual(SETTLE);
    expect(network.submitted).toHaveLength(1);
  });

  it('is settled by the message turning up in Sent, from a provider that files its own copy', async () => {
    const { rerender, vault, bytes } = await sendLost();
    await rerender({
      baseByAccount: {
        [ACCOUNT.address]: { sent: { uidValidity: 7, summaries: [await serverCopyOf(bytes)] } },
      },
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('goes out again, the same bytes, under a fresh claim on Send again', async () => {
    const lost = await sendLost();
    await reopen(lost, lost.draft.draftKey);
    network.submitAnswer = { ok: true, value: undefined };
    const answer = await act(() => lost.hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Send again was refused');
    await act(() => answer.value.settled);
    expect(network.submitted).toEqual([lost.bytes, lost.bytes]);
    expect(await listDrafts(lost.vault.store)).toEqual([]);
  });
});

/** A send another tab left in the vault, listed the way an unlock finds it. */
const leftInVault = async (state: 'submitting' | 'submitted', claimedAt = 0) => {
  const vault = vaultOver(fakeRecordStore().store);
  const bytes = new TextEncoder().encode(
    `From: Me <${ACCOUNT.address}>\r\nTo: you@x.test\r\nMessage-ID: <left@x.test>\r\nDate: Tue, 1 Jan 2030 00:00:00 +0000\r\nSubject: Plans\r\n\r\nHello`,
  );
  const created = await createDraft(vault.store, content(), 0);
  if (!created.ok) throw new Error('no draft to claim');
  const claimed = await claimSend(vault.store, created.handle.draftId, {
    messageId: '<left@x.test>',
    opId: 'op-left',
    state,
    claimedAt,
    message: { head: bytes.toBase64(), splices: [] },
    target: { account: ACCOUNT.address, folder: 'sent' },
  });
  if (!claimed.ok) throw new Error('no claim to leave');
  return { vault, bytes, handle: claimed.handle };
};

const reopenedAs = async ({ hook }: Pick<Mounted, 'hook'>, draftKey: string) => {
  await act(async () => {
    hook().composer.seedDraft(`draft:${draftKey}`, {});
  });
  const { openSendState, isOpenDraftFrozen } = hook().composer;
  return { openSendState, isOpenDraftFrozen };
};

describe('a send SMTP accepted, whose copy will not land', () => {
  const stuck = async () => {
    network.sentCopy = { ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Full' } } };
    const { vault, handle } = await leftInVault('submitted');
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    return { ...mounted, vault, handle };
  };

  it('stays frozen however old, saying it went out', async () => {
    const { handle, ...mounted } = await stuck();
    expect(await reopenedAs(mounted, handle.draftKey)).toEqual({
      openSendState: 'accepted',
      isOpenDraftFrozen: true,
    });
  });

  it('is never delivered again by Save to Sent or Back to editing', async () => {
    const { vault, handle, hook } = await stuck();
    await act(() => hook().composer.backToEditing());
    expect(hook().composer.openSendState).toBe('accepted');

    const answer = await act(() => hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Save to Sent was refused');
    expect(await act(() => answer.value.settled)).toMatchObject({ state: 'sent-with-caveat' });
    expect(network.submitted).toEqual([]);

    // Still only the copy, from the vault alone after a reload.
    const reloaded = await mount(vault.store);
    await reopenedAs(reloaded, handle.draftKey);
    expect(reloaded.hook().composer.openSendState).toBe('accepted');
    expect(network.submitted).toEqual([]);
  });

  it('stores the copy on Save to Sent once it can land', async () => {
    const { hook, vault } = await stuck();
    network.sentCopy = { ok: true, value: null };
    const answer = await act(() => hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Save to Sent was refused');
    expect(await act(() => answer.value.settled)).toEqual({ state: 'sent' });
    expect(network.submitted).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('lets the person finish without it', async () => {
    const { hook, vault } = await stuck();
    await act(() => hook().composer.finishWithoutCopy());
    expect(network.submitted).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);
    expect(hook().shared.drafts).toEqual([]);
  });
});

describe('an unlock finding a send with no Sent folder', () => {
  it('finishes it, with nothing left to press and nothing sent', async () => {
    network.sentCopy = { ok: false, error: { kind: 'no-sent-mailbox' } };
    const { vault } = await leftInVault('submitted');
    const { hook } = await mount(vault.store);
    expect(hook().shared.drafts).toEqual([]);
    expect(await listDrafts(vault.store)).toEqual([]);
    expect(network.submitted).toEqual([]);
  });
});

describe('a claim a dead tab left at `submitting`', () => {
  const left = async () => {
    const { vault, bytes, handle } = await leftInVault('submitting');
    const mounted = await mount(vault.store);
    return { ...mounted, vault, bytes, handle };
  };

  it('is the same question as a lost answer, and frozen until settled', async () => {
    const { handle, ...mounted } = await left();
    expect(await reopenedAs(mounted, handle.draftKey)).toEqual({
      openSendState: 'unconfirmed',
      isOpenDraftFrozen: true,
    });
    expect(network.submitted).toEqual([]);
  });

  it('goes out once however often Send again is pressed', async () => {
    const { vault, handle, ...mounted } = await left();
    const { hook } = mounted;
    await reopenedAs(mounted, handle.draftKey);
    network.smtp = Promise.withResolvers();
    const answers = await act(() =>
      Promise.all([hook().composer.sendAgain(), hook().composer.sendAgain()]),
    );
    const claimed = answers.filter(answer => answer?.ok === true);
    expect(claimed).toHaveLength(1);
    expect(answers.filter(answer => answer === null)).toHaveLength(1);
    await vi.waitFor(() => expect(network.submitted).toHaveLength(1));

    network.smtp.resolve();
    const [answer] = claimed;
    if (answer === undefined || answer === null || !answer.ok) throw new Error('no claim');
    await act(() => answer.value.settled);
    expect(network.submitted).toHaveLength(1);
    expect(await listDrafts(vault.store)).toEqual([]);
  });

  it('is not sent by a second device that had the same stale list', async () => {
    const { vault, handle, ...here } = await left();
    const there = await mount(vault.store);
    await reopenedAs(here, handle.draftKey);
    await reopenedAs(there, handle.draftKey);
    network.smtp = Promise.withResolvers();
    const answer = await act(() => here.hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Send again was refused');
    await vi.waitFor(() => expect(network.submitted).toHaveLength(1));

    await act(() => there.hook().composer.sendAgain());
    expect(network.submitted).toHaveLength(1);
    // The refusal tells that device what is really going on.
    expect(there.hook().composer.openSendState).toBe('sending');

    network.smtp.resolve();
    await act(() => answer.value.settled);
  });

  it('is settled by the message turning up in Sent', async () => {
    const { rerender, vault, bytes } = await left();
    await rerender({
      baseByAccount: {
        [ACCOUNT.address]: { sent: { uidValidity: 7, summaries: [await serverCopyOf(bytes)] } },
      },
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    expect(await listDrafts(vault.store)).toEqual([]);
    expect(network.submitted).toEqual([]);
  });
});

describe('the sending tab, while its send runs', () => {
  it('shows the draft frozen when it is reopened', async () => {
    network.smtp = Promise.withResolvers();
    const { settled, ...mounted } = await claimOne();
    const [listed] = mounted.hook().shared.drafts;
    if (listed === undefined) throw new Error('the claimed draft should be listed');
    expect(listed.record.send?.state).toBe('submitting');
    expect(await reopenedAs(mounted, listed.draftKey)).toEqual({
      openSendState: 'sending',
      isOpenDraftFrozen: true,
    });

    network.smtp.resolve();
    expect(await act(() => settled)).toEqual({ state: 'sent' });
  });
});

describe("a draft on screen while another device's send holds it", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const onScreen = async () => {
    const { vault, handle } = await leftInVault('submitting', Date.now());
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    return { ...mounted, vault, handle };
  };

  const wait = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

  it('frees itself about 3 minutes after that tab dies, with no click', async () => {
    const { hook } = await onScreen();
    expect(hook().composer.openSendState).toBe('sending');
    await wait(2 * 60_000);
    expect(hook().composer.openSendState).toBe('sending');
    await wait(2 * 60_000);
    expect(hook().composer.openSendState).toBe('unconfirmed');
    expect(network.submitted).toEqual([]);
  });

  it('stays frozen past 15 minutes while its lease is renewed', async () => {
    const { hook, vault } = await onScreen();
    for (const _minute of Array.from({ length: 20 })) {
      await vault.store.put({
        type: SEND_LEASE_RECORD_TYPE,
        naturalKey: 'op-left',
        plaintext: JSON.stringify({ renewedAt: Date.now() }),
      });
      await wait(60_000);
      expect(hook().composer.openSendState).toBe('sending');
    }
  });

  it('stops looking once the composer closes', async () => {
    const { hook } = await onScreen();
    const before = vi.getTimerCount();
    await act(async () => {
      hook().composer.seedDraft(undefined, {});
    });
    expect(vi.getTimerCount()).toBeLessThan(before);
  });
});

describe('the draft on screen when its send ends', () => {
  const openOn = async (state: 'submitting' | 'submitted', claimedAt = 0) => {
    const { vault, bytes, handle } = await leftInVault(state, claimedAt);
    network.sentCopy = { ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Full' } } };
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    network.sentCopy = { ok: true, value: null };
    return { ...mounted, vault, bytes, handle };
  };

  const closedCleanly = ({ hook }: Pick<Mounted, 'hook'>) => {
    expect(hook().composer.draft).toBeNull();
    expect(hook().composer.draftConflict).toBeNull();
    expect(hook().composer.draftError).toBeNull();
  };

  /** What the composer's close runs once the URL lets go, which must file nothing over a sent draft. */
  const closeComposer = ({ hook }: Pick<Mounted, 'hook'>) =>
    act(async () => {
      hook().composer.seedDraft(undefined, {});
    });

  it('closes on Finish without copy, and the close files nothing', async () => {
    const mounted = await openOn('submitted');
    await act(() => mounted.hook().composer.finishWithoutCopy());
    closedCleanly(mounted);
    await closeComposer(mounted);
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    closedCleanly(mounted);
  });

  it('closes at the claim on Save to Sent, and reports through the toast', async () => {
    const mounted = await openOn('submitted');
    const answer = await act(() => mounted.hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Save to Sent was refused');
    closedCleanly(mounted);
    expect(await act(() => answer.value.settled)).toEqual({ state: 'sent' });
    expect(network.submitted).toEqual([]);
    expect(await listDrafts(mounted.vault.store)).toEqual([]);
  });

  it('closes at the claim on Send again, while the send is still on the network', async () => {
    const mounted = await openOn('submitting');
    network.smtp = Promise.withResolvers();
    const answer = await act(() => mounted.hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('Send again was refused');
    closedCleanly(mounted);
    network.smtp.resolve();
    await act(() => answer.value.settled);
  });

  it('closes when another device finishes it, without a press', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const { vault, handle } = await leftInVault('submitted', Date.now());
      const mounted = await mount(vault.store);
      await reopenedAs(mounted, handle.draftKey);
      expect(mounted.hook().composer.openSendState).toBe('sending');
      await completeSend(vault.store, handle.draftId, '<left@x.test>', Date.now());
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      closedCleanly(mounted);
      await closeComposer(mounted);
      closedCleanly(mounted);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes when the message turns up in Sent', async () => {
    const mounted = await openOn('submitting');
    await mounted.rerender({
      baseByAccount: {
        [ACCOUNT.address]: {
          sent: { uidValidity: 7, summaries: [await serverCopyOf(mounted.bytes)] },
        },
      },
    });
    await act(() => new Promise(resolve => setTimeout(resolve, 20)));
    closedCleanly(mounted);
  });

  it('closes on the sending tab when the send it reopened finishes', async () => {
    network.smtp = Promise.withResolvers();
    const { settled, ...mounted } = await claimOne();
    const [listed] = mounted.hook().shared.drafts;
    if (listed === undefined) throw new Error('the claimed draft should be listed');
    await reopenedAs(mounted, listed.draftKey);
    expect(mounted.hook().composer.draft).not.toBeNull();

    network.smtp.resolve();
    expect(await act(() => settled)).toEqual({ state: 'sent' });
    closedCleanly(mounted);
  });

  it('never has a live Send in any render after the record goes', async () => {
    const mounted = await openOn('submitted');
    mounted.composers.length = 0;
    await act(() => mounted.hook().composer.finishWithoutCopy());
    const shown = mounted.composers.filter(({ draft }) => draft !== null);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every(({ isOpenDraftFrozen }) => isOpenDraftFrozen)).toBe(true);
    expect(mounted.hook().composer.draft).toBeNull();
  });

  it('leaves an ordinary draft another device discarded open, with what was typed', async () => {
    const { hook, vault, created } = await openInComposer();
    await act(async () => hook().composer.updateDraft({ body: 'Still typing' }));
    await deleteDraft(vault.store, created.draftId, 0);
    await act(() => hook().shared.writeDraft({ content: content({ body: 'Elsewhere' }) }));
    expect(hook().composer.draft?.body).toBe('Still typing');
  });
});

describe('Send again and Save to Sent report as Send does', () => {
  const left = async (state: 'submitting' | 'submitted') => {
    const { vault, bytes, handle } = await leftInVault(state);
    network.sentCopy = { ok: false, error: { kind: 'imap', reason: { kind: 'no', text: 'Full' } } };
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    network.sentCopy = { ok: true, value: null };
    return { ...mounted, vault, bytes, handle };
  };

  const press = async ({ hook }: Pick<Mounted, 'hook'>) => {
    const answer = await act(() => hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('the press was refused');
    return answer.value.settled;
  };

  it("says no Sent folder was there, and shows this tab's copy", async () => {
    const mounted = await left('submitted');
    network.sentCopy = { ok: false, error: { kind: 'no-sent-mailbox' } };
    expect(await act(() => press(mounted))).toEqual({
      state: 'sent-with-caveat',
      detail: 'imap.x has no Sent folder to keep a copy in',
    });
    expect(mounted.hook().shared.sentCopyError).toBe(
      'sent, but imap.x has no Sent folder to keep a copy in',
    );
    expect(mounted.hook().vaultSent.map(({ messageId }) => messageId)).toEqual(['<left@x.test>']);
    expect(await listDrafts(mounted.vault.store)).toEqual([]);
  });

  it('says a copy that failed again failed', async () => {
    const mounted = await left('submitted');
    network.sentCopy = { ok: false, error: { kind: 'stalled' } };
    expect(await act(() => press(mounted))).toMatchObject({ state: 'sent-with-caveat' });
  });

  it('counts as work on the network, so a reload asks first', async () => {
    const mounted = await left('submitting');
    network.smtp = Promise.withResolvers();
    const answer = await act(() => mounted.hook().composer.sendAgain());
    if (answer === null || !answer.ok) throw new Error('the press was refused');
    const { settled } = answer.value;
    expect(mounted.activity.snapshot().some(isUnsavedWork)).toBe(true);
    network.smtp.resolve();
    await act(() => settled);
    expect(mounted.activity.snapshot().some(isUnsavedWork)).toBe(false);
  });

  it('gives the draft back on a refusal, at the version Reopen needs', async () => {
    const mounted = await left('submitting');
    network.submitAnswer = { ok: false, error: { kind: 'error', detail: 'refused by the host' } };
    expect(await act(() => press(mounted))).toEqual({
      state: 'refused',
      detail: 'refused by the host',
      draftKey: mounted.handle.draftKey,
    });
    await reopenedAs(mounted, mounted.handle.draftKey);
    const { draft, openSendState, isOpenDraftFrozen } = mounted.hook().composer;
    const [back] = await listDrafts(mounted.vault.store);
    expect({ openSendState, isOpenDraftFrozen }).toEqual({
      openSendState: null,
      isOpenDraftFrozen: false,
    });
    expect(draft?.draftId).toBe(back?.draftId);
  });

  it('stays open and says nothing new when the send is running after all', async () => {
    const mounted = await left('submitting');
    await reclaimSend(mounted.vault.store, mounted.handle.draftId, Date.now());
    expect(await act(() => mounted.hook().composer.sendAgain())).toBeNull();
    expect(network.submitted).toEqual([]);
    expect(mounted.hook().composer.openSendState).toBe('sending');
  });

  it('says so when the address has gone, and leaves the draft as it was', async () => {
    const mounted = await left('submitted');
    await mounted.rerender({ identities: [] });
    expect(await act(() => mounted.hook().composer.sendAgain())).toEqual({
      ok: false,
      error: { kind: 'error', detail: 'That address was removed' },
    });
    expect(mounted.hook().composer.openSendState).toBe('accepted');
  });
});

describe('Back to editing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const setAside = async () => {
    const { vault, handle } = await leftInVault('submitting');
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    await act(() => mounted.hook().composer.backToEditing());
    return { ...mounted, vault, handle };
  };

  it('names the version it wrote, so the next autosave is no conflict with itself', async () => {
    const { hook, vault } = await setAside();
    const [current] = await listDrafts(vault.store);
    expect(hook().composer.draft?.draftId).toBe(current?.draftId);

    await act(async () => hook().composer.updateDraft({ body: 'Edited after all' }));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(hook().composer.draftConflict).toBeNull();
    expect((await listDrafts(vault.store))[0]?.record.body).toBe('Edited after all');
  });

  it('saves what was typed while it was frozen, as no conflict with itself', async () => {
    const { vault, handle } = await leftInVault('submitting');
    const mounted = await mount(vault.store);
    await reopenedAs(mounted, handle.draftKey);
    await act(async () => mounted.hook().composer.updateDraft({ body: 'Typed while frozen' }));
    await act(() => mounted.hook().composer.backToEditing());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mounted.hook().composer.draftConflict).toBeNull();
    expect((await listDrafts(vault.store))[0]?.record.body).toBe('Typed while frozen');
  });

  describe('pressed on another device', () => {
    /** This device has it open and frozen; that one sets it aside, and maybe edits it, before the next poll. */
    const elsewhere = async (edit: (store: RecordStore, draftId: string) => Promise<unknown>) => {
      const { vault, handle } = await leftInVault('submitting');
      const mounted = await mount(vault.store);
      await reopenedAs(mounted, handle.draftKey);
      const aside = await unconfirmSend(vault.store, handle.draftId, Date.now());
      if (aside === null) throw new Error('that device could not set it aside');
      await edit(vault.store, aside.draftId);
      await act(async () => vi.advanceTimersByTimeAsync(45_000));
      expect(mounted.hook().composer.openSendState).toBe('unconfirmed');
      return { ...mounted, vault, handle };
    };

    it('does not overwrite an edit made there, and leaves it to the conflict flow', async () => {
      const { hook, vault, handle } = await elsewhere((store, draftId) =>
        replaceDraft(store, draftId, content({ body: 'Theirs' }), Date.now()),
      );
      expect(hook().composer.draft?.draftId).toBe(handle.draftId);
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect((await listDrafts(vault.store))[0]?.record.body).toBe('Theirs');

      await act(async () => hook().composer.updateDraft({ body: 'Mine' }));
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(hook().composer.draftConflict?.record.body).toBe('Theirs');
      expect((await listDrafts(vault.store))[0]?.record.body).toBe('Theirs');
    });

    it('takes the version when the text did not change there', async () => {
      const { hook, vault } = await elsewhere(async () => {});
      const [current] = await listDrafts(vault.store);
      expect(hook().composer.draft?.draftId).toBe(current?.draftId);
      await act(async () => hook().composer.updateDraft({ body: 'Mine' }));
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
      expect(hook().composer.draftConflict).toBeNull();
      expect((await listDrafts(vault.store))[0]?.record.body).toBe('Mine');
    });
  });

  it('lets the next Send claim it, with no refusal as edited elsewhere', async () => {
    const { hook } = await setAside();
    const answer = await act(() => hook().composer.send());
    expect(answer.ok).toBe(true);
    if (answer.ok) await act(() => answer.value.settled);
    expect(network.submitted).toHaveLength(1);
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
    await act(() => opened.hook().load(storesOf(opened.vault.store), [ACCOUNT], () => false));
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
      await claimSend(vault.store, sending.handle.draftId, {
        messageId: '<plans@x.test>',
        opId: 'op-1',
        state: 'submitted',
        claimedAt: 0,
        message: {
          head: new TextEncoder().encode('Subject: Plans\r\n\r\nHello').toBase64(),
          splices: [],
        },
        target: { account: ACCOUNT.address, folder: 'sent' },
      });
      const copying = gate();
      network.copying = copying;
      const mounted = await render(vault.store);
      let isCancelled = false;
      const { unlocked } = await act(async () => ({
        unlocked: mounted.hook().load(storesOf(vault.store), [ACCOUNT], () => isCancelled),
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
        const claimed = await claimSend(vault.store, created.handle.draftId, {
          messageId,
          opId: subject,
          state: 'submitting',
          claimedAt: 0,
          message: { head: bytes.toBase64(), splices: [] },
          target: { account: ACCOUNT.address, folder: 'sent' },
        });
        if (!claimed.ok) throw new Error('no claim to leave unconfirmed');
        await unconfirmSend(vault.store, claimed.handle.draftId, Date.now());
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
