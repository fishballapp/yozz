import { describe, expect, it, vi } from 'vitest';
import { addressList } from '../compose/draft';
import type { DraftRecord } from '../compose/draft-record';
import type { DraftHandle } from '../compose/draft-vault';
import type { BodyOutcome } from '../threads/body-state';
import { type Folder, type Message, type ThreadState, VAULT_UID_VALIDITY } from '../threads/thread';
import {
  type AgentPort,
  BODY_CHARS,
  buildAgentTools,
  OUTPUT_CHARS,
  RECIPIENTS_LISTED,
} from './tools';

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  fromName: 'Ada',
  fromAddress: 'ada@example.com',
  toAddress: 'me@yozz.app',
  at: Date.UTC(2026, 7, 26, 12),
  body: ['Hello there.'],
  messageId: `<${id}@example.com>`,
  ...overrides,
});

const thread = (
  id: string,
  folders: readonly Folder[],
  overrides: Partial<ThreadState> = {},
): ThreadState => ({
  id,
  accounts: ['me@yozz.app'],
  foldersByAccount: { 'me@yozz.app': folders },
  subject: `Subject ${id}`,
  messages: [message(`${id}/1`)],
  isUnread: true,
  isReplied: false,
  isStarred: false,
  folders,
  ...overrides,
});

const draftRecord = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  from: 'me@yozz.app',
  to: 'ada@example.com',
  cc: '',
  bcc: '',
  subject: 'Half written',
  body: 'A start',
  contentVersion: 2,
  updatedAt: Date.UTC(2026, 7, 26, 13),
  ...over,
});

const handle = (draftKey: string, record = draftRecord()): DraftHandle => ({
  draftKey,
  draftId: `${draftKey}@${record.contentVersion}`,
  record,
});

/** A port over mutable state, so a tool can observe what the app would have changed. */
const fakePort = (threads: ThreadState[], overrides: Partial<AgentPort> = {}) => {
  /** Bumped by `endSession`, as a lock or a sign-in bumps the store's. */
  const state = { threads, drafts: [] as DraftHandle[], written: [] as unknown[], generation: 0 };
  const loadedBody = (body: string[]): BodyOutcome => ({
    status: 'loaded',
    body,
    hasTextPart: true,
    inlineImagesTruncated: false,
    attachments: [],
  });
  const port: AgentPort = {
    addresses: [
      { address: 'me@yozz.app', isInbound: true },
      { address: 'alias@yozz.app', isInbound: false },
    ],
    identities: [
      { address: 'me@yozz.app', smtp: { host: 's', port: 465, username: 'u', password: 'p' } },
    ],
    ownedAddresses: ['me@yozz.app', 'alias@yozz.app'],
    get threads() {
      return state.threads;
    },
    get drafts() {
      return state.drafts;
    },
    loadBody: vi.fn(async (threadId: string, messageId: string) => {
      const found = state.threads
        .find(t => t.id === threadId)
        ?.messages.find(m => m.id === messageId);
      if (found === undefined) return { status: 'failed' } as const;
      // The fake never publishes a render: the tool must not need one.
      return loadedBody(found.bodyStatus === undefined ? found.body : ['Loaded body.']);
    }),
    markRead: vi.fn(() => true),
    markUnread: vi.fn(() => true),
    archive: vi.fn(() => true),
    trash: vi.fn(() => true),
    setStar: vi.fn(() => true),
    restore: vi.fn(() => true),
    openThread: vi.fn(async () => {}),
    openDraft: vi.fn(async () => {}),
    writeDraft: vi.fn(async input => {
      state.written.push(input);
      const record = draftRecord({ ...input.content, contentVersion: 3 });
      return { ok: true as const, handle: handle('k1', record) };
    }),
    removeDraft: vi.fn(async (draftId: string) => ({
      outcome: 'deleted' as const,
      draftId: `${draftId}-tombstone`,
    })),
    watchSession: () => {
      const taken = state.generation;
      return () => state.generation === taken;
    },
    ...overrides,
  };
  return {
    port,
    state,
    tools: buildAgentTools(() => port),
    endSession: () => {
      state.generation += 1;
    },
  };
};

const call = (tools: ReturnType<typeof buildAgentTools>, name: string, input: unknown) => {
  const found = tools.find(t => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found.execute(input);
};

describe('the tool set', () => {
  it('registers six tools with JSON Schema inputs and hints', () => {
    const { tools } = fakePort([]);
    expect(tools.map(t => t.name)).toEqual([
      'get_addresses',
      'get_threads',
      'update_threads',
      'save_draft',
      'delete_draft',
      'navigate',
    ]);
    expect(tools.find(t => t.name === 'get_threads')?.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    // Stated, not absent: ChatGPT counts a tool as a write only when it says so.
    expect(tools.find(t => t.name === 'update_threads')?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(tools.find(t => t.name === 'save_draft')?.annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
      consequentialHint: true,
    });
    for (const t of tools) expect(t.description.length).toBeLessThanOrEqual(700);
  });

  it('returns a parse failure as text, never a throw', async () => {
    const { tools } = fakePort([]);
    await expect(call(tools, 'save_draft', { from: 'not-an-email' })).resolves.toMatchObject({
      error: expect.stringContaining('body'),
    });
  });
});

describe('get_threads', () => {
  const inbox = thread('a', ['inbox']);
  const archived = thread('b', ['archive'], {
    messages: [message('b/1', { body: ['Invoice attached, please pay.'] })],
  });

  it('lists the inbox by default, with a snippet and no bodies', async () => {
    const { tools } = fakePort([inbox, archived]);
    const result = await call(tools, 'get_threads', {});
    expect(result).toMatchObject({
      total: 1,
      threads: [
        {
          id: 'a',
          subject: 'Subject a',
          accounts: ['me@yozz.app'],
          mailboxes: ['inbox'],
          isUnread: true,
          hasDraft: false,
          snippet: 'Hello there.',
        },
      ],
    });
  });

  it('answers nothing it read once the session ended under it', async () => {
    const body = Promise.withResolvers<BodyOutcome>();
    const { tools, endSession } = fakePort([archived], { loadBody: () => body.promise });
    const result = call(tools, 'get_threads', { ids: ['b'], body: 'latest' });
    endSession();
    body.resolve({
      status: 'loaded',
      body: ['Invoice attached, please pay.'],
      hasTextPart: true,
      inlineImagesTruncated: false,
      attachments: [],
    });
    await expect(result).resolves.toEqual({ error: expect.stringContaining('locked') });
  });

  it('says which mailboxes hold each message, so a mixed thread is legible', async () => {
    const location = (folder: Folder) => ({
      account: 'me@yozz.app',
      folder,
      uidValidity: 1,
      uid: 7,
    });
    // A thread holding a draft always lists 'drafts' too.
    const mixed = thread('m', ['inbox', 'sent', 'drafts'], {
      messages: [
        message('m/1', { locations: [location('inbox')] }),
        message('m/2', { locations: [location('sent')] }),
        message('m/3', { isDraft: true, draftKey: 'k1', draftId: 'k1@2' }),
      ],
    });
    const { tools } = fakePort([mixed, inbox]);
    const result = await call(tools, 'get_threads', { ids: ['m'], body: 'full' });
    expect(result).toMatchObject({
      threads: [
        {
          mailboxes: ['inbox', 'sent', 'drafts'],
          messages: [
            { id: 'm/3', mailboxes: ['drafts'] },
            { id: 'm/2', mailboxes: ['sent'] },
            { id: 'm/1', mailboxes: ['inbox'] },
          ],
        },
      ],
    });
    // A message with no locations, like this file's own `message()`, names no mailbox.
    const fixture = await call(tools, 'get_threads', { ids: ['a'], body: 'latest' });
    const [only] = (fixture as { threads: { messages: Record<string, unknown>[] }[] }).threads;
    expect(only?.messages[0]).not.toHaveProperty('mailboxes');
  });

  it('gives the recipients and the inbox it landed in, which need not agree', async () => {
    // To a billing alias that forwards into me@: delivered somewhere To does not name.
    const forwarded = thread('f', ['inbox'], {
      messages: [
        message('f/1', {
          to: [{ name: 'Doe, Jane', address: 'billing@yozz.app' }],
          cc: [{ name: 'Ops', address: 'ops@example.com' }],
          locations: [{ account: 'me@yozz.app', folder: 'inbox', uidValidity: 1, uid: 3 }],
        }),
      ],
    });
    const { tools } = fakePort([forwarded]);
    const result = await call(tools, 'get_threads', { ids: ['f'], body: 'latest' });
    expect(result).toMatchObject({
      threads: [
        {
          messages: [
            {
              from: 'Ada <ada@example.com>',
              to: 'billing@yozz.app',
              cc: 'ops@example.com',
              deliveredTo: 'me@yozz.app',
            },
          ],
        },
      ],
    });
    // Bare addresses, so what comes out goes back into save_draft as the same recipients.
    const [first] =
      (result as { threads: { messages: { to: string }[] }[] }).threads[0]?.messages ?? [];
    expect(addressList(first?.to ?? '')).toEqual(['billing@yozz.app']);

    // Your own sent copy was delivered nowhere of yours.
    const own = thread('o', ['sent'], {
      messages: [
        message('o/1', {
          fromAddress: 'me@yozz.app',
          to: [{ address: 'ada@example.com' }],
          locations: [{ account: 'me@yozz.app', folder: 'sent', uidValidity: 1, uid: 4 }],
        }),
      ],
    });
    const { tools: ownTools } = fakePort([own]);
    const sent = await call(ownTools, 'get_threads', { ids: ['o'], body: 'latest' });
    const [message0] =
      (sent as { threads: { messages: Record<string, unknown>[] }[] }).threads[0]?.messages ?? [];
    expect(message0).toMatchObject({ to: 'ada@example.com' });
    expect(message0).not.toHaveProperty('deliveredTo');
    expect(message0).not.toHaveProperty('cc');
    expect(message0).not.toHaveProperty('recipientsOmitted');
  });

  it('lists a capped number of recipients and says how many it left out', async () => {
    const crowd = Array.from({ length: 200 }, (_, index) => ({
      name: `Person Number ${index} With A Long Name`,
      address: `person-${index}@a-long-mailing-list-domain.example`,
    }));
    const blast = thread('b', ['inbox'], { messages: [message('b/1', { to: crowd })] });
    const { tools } = fakePort([blast]);
    const result = await call(tools, 'get_threads', { ids: ['b'], body: 'latest' });
    const [only] =
      (result as { threads: { messages: { to: string; recipientsOmitted: number }[] }[] })
        .threads[0]?.messages ?? [];
    expect(addressList(only?.to ?? '')).toHaveLength(RECIPIENTS_LISTED);
    expect(only?.recipientsOmitted).toBe(200 - RECIPIENTS_LISTED);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(OUTPUT_CHARS);
  });

  it('reads bodies only when asked, and only as deep as asked', async () => {
    const { tools, port } = fakePort([inbox]);
    const latest = await call(tools, 'get_threads', { ids: ['a'], body: 'latest' });
    expect(latest).toMatchObject({ threads: [{ messages: [{ body: 'Hello there.' }] }] });
    expect(port.loadBody).toHaveBeenCalledTimes(1);

    const rows = await call(tools, 'get_threads', {});
    expect(rows).toMatchObject({ threads: [{ messages: [{ id: 'a/1' }] }] });
    // Still once: a row does not fetch a body.
    expect(port.loadBody).toHaveBeenCalledTimes(1);
  });

  it('pages from what it returned, so a body budget cannot strand a conversation', async () => {
    const long = (id: string) =>
      thread(id, ['inbox'], { messages: [message(`${id}/1`, { body: ['x'.repeat(4_000)] })] });
    const { tools } = fakePort([long('a'), long('b'), long('c')]);
    // Three whole bodies at 4K each blow the 6K budget, so only the first survives.
    const page = await call(tools, 'get_threads', { body: 'full', bodyChars: 4_000 });
    expect(page).toMatchObject({ total: 3, omittedThreads: 2, nextOffset: 1 });
    expect((page as { threads: unknown[] }).threads).toHaveLength(1);
    // The dropped two are still reachable by offset.
    await expect(
      call(tools, 'get_threads', { body: 'full', bodyChars: 4_000, offset: 1 }),
    ).resolves.toMatchObject({ threads: [{ id: 'b' }], nextOffset: 2 });
  });

  it('searches, filters by mailbox and account, and pages', async () => {
    const { tools } = fakePort([inbox, archived]);
    await expect(call(tools, 'get_threads', { mailbox: 'archive' })).resolves.toMatchObject({
      threads: [{ id: 'b' }],
    });
    await expect(
      call(tools, 'get_threads', { mailbox: 'archive', query: 'invoice' }),
    ).resolves.toMatchObject({ threads: [{ id: 'b' }] });
    await expect(
      call(tools, 'get_threads', { mailbox: 'archive', query: 'nothing here' }),
    ).resolves.toMatchObject({ threads: [], total: 0 });
    // An address's own view is the inbox filtered to that account.
    await expect(
      call(tools, 'get_threads', { account: 'someone@else.com' }),
    ).resolves.toMatchObject({ total: 0 });
  });

  it('answers any message id as the conversation, and names ids it has never seen', async () => {
    const { tools } = fakePort([inbox]);
    const result = await call(tools, 'get_threads', { ids: ['a/1', 'nope'] });
    expect(result).toMatchObject({ threads: [{ id: 'a' }], notFound: ['nope'] });
  });

  it('answers a conversation once when several ids name it', async () => {
    const { tools } = fakePort([inbox]);
    // A thread id and a message id in the same thread are both valid handles.
    await expect(call(tools, 'get_threads', { ids: ['a', 'a/1'] })).resolves.toMatchObject({
      threads: [{ id: 'a' }],
      total: 1,
    });
  });

  it('clips a body to the budget, and to `bodyChars` when the caller names one', async () => {
    const long = thread('c', ['inbox'], {
      messages: [message('c/1', { body: ['x'.repeat(9_000)] })],
    });
    const { tools } = fakePort([long]);
    const read = async (input: object) => {
      const result = (await call(tools, 'get_threads', input)) as {
        threads: { messages: { body: string }[] }[];
      };
      return result.threads[0]?.messages[0]?.body ?? '';
    };

    const byDefault = await read({ ids: ['c'], body: 'latest' });
    expect(byDefault.length).toBeLessThan(BODY_CHARS + 60);
    expect(byDefault).toContain('truncated');
    // The caller's number is honoured.
    expect((await read({ ids: ['c'], body: 'latest', bodyChars: 200 })).length).toBeLessThan(260);
  });

  it('shows a draft as part of its conversation', async () => {
    const withDraft = thread('d', ['inbox', 'drafts'], {
      messages: [
        message('d/1'),
        message('draft/k1', { isDraft: true, draftKey: 'k1', draftId: 'k1@2', body: ['A start'] }),
      ],
    });
    const { tools } = fakePort([withDraft]);
    await expect(call(tools, 'get_threads', { ids: ['d'], body: 'full' })).resolves.toMatchObject({
      threads: [
        {
          hasDraft: true,
          messages: [{ id: 'draft/k1', isDraft: true, draftKey: 'k1' }, { id: 'd/1' }],
        },
      ],
    });
  });
});

describe('update_threads', () => {
  it('writes only what differs, one row per id, and says what it did', async () => {
    const { tools, port } = fakePort([thread('a', ['inbox'], { isStarred: false })]);
    const result = await call(tools, 'update_threads', {
      ids: ['a'],
      read: true,
      starred: true,
    });
    expect(result).toEqual({ results: [{ id: 'a', status: 'ok', isRead: true, isStarred: true }] });
    expect(port.markRead).toHaveBeenCalledWith('a');
    expect(port.setStar).toHaveBeenCalledWith('a', true);
  });

  it('reports a state that was already right without repeating the write', async () => {
    const { tools, port } = fakePort([
      thread('a', ['archive'], { isUnread: false, isStarred: true }),
    ]);
    const result = await call(tools, 'update_threads', {
      ids: ['a'],
      read: true,
      starred: true,
      mailbox: 'archive',
    });
    expect(result).toMatchObject({
      results: [{ id: 'a', status: 'ok', mailbox: 'archive', note: 'already archived' }],
    });
    expect(port.markRead).not.toHaveBeenCalled();
    expect(port.setStar).not.toHaveBeenCalled();
    expect(port.archive).not.toHaveBeenCalled();
  });

  it('moves nothing that is not in the inbox, and names an unknown id', async () => {
    const { tools, port } = fakePort([thread('a', ['sent'])]);
    const result = await call(tools, 'update_threads', { ids: ['a', 'ghost'], mailbox: 'archive' });
    expect(result).toMatchObject({
      results: [
        { id: 'a', status: 'ok', note: 'nothing in the inbox to archive' },
        { id: 'ghost', status: 'not_found' },
      ],
    });
    expect(port.archive).not.toHaveBeenCalled();
  });

  it('changes a conversation once when several ids name it', async () => {
    const { tools, port } = fakePort([thread('a', ['inbox'], { isStarred: false })]);
    // The second pass would see the first one's pending move and report a refusal.
    const result = await call(tools, 'update_threads', { ids: ['a', 'a/1'], starred: true });
    expect(result).toEqual({ results: [{ id: 'a', status: 'ok', isStarred: true }] });
    expect(port.setStar).toHaveBeenCalledTimes(1);
  });

  it('reports a write the store refused while a move is still being confirmed', async () => {
    const onServer = thread('a', ['inbox'], {
      messages: [
        message('a/1', {
          locations: [{ account: 'me@yozz.app', folder: 'inbox', uidValidity: 1, uid: 3 }],
        }),
      ],
    });
    const { tools } = fakePort([onServer], { archive: () => false });
    await expect(
      call(tools, 'update_threads', { ids: ['a'], mailbox: 'archive' }),
    ).resolves.toMatchObject({
      results: [{ id: 'a', status: 'pending', note: expect.stringContaining('confirmed') }],
    });
  });

  it('says why a conversation no server holds a copy of did not change', async () => {
    // A message just sent whose Sent copy failed: this tab's own copy is the only one.
    const justSent = thread('a', ['sent'], {
      isUnread: false,
      messages: [
        message('a/1', {
          locations: [
            { account: 'me@yozz.app', folder: 'sent', uidValidity: VAULT_UID_VALIDITY, uid: 0 },
          ],
        }),
      ],
    });
    const { tools } = fakePort([justSent], { trash: () => false });
    await expect(
      call(tools, 'update_threads', { ids: ['a'], mailbox: 'trash' }),
    ).resolves.toMatchObject({
      results: [{ id: 'a', status: 'pending', note: expect.stringContaining('mail server') }],
    });
  });

  it('refuses a call that asks for no change at all', async () => {
    const { tools } = fakePort([]);
    await expect(call(tools, 'update_threads', { ids: ['a'] })).resolves.toMatchObject({
      error: expect.stringContaining('read'),
    });
  });
});

describe('save_draft and delete_draft', () => {
  it('writes a new message and never sends it', async () => {
    const { tools, state } = fakePort([]);
    const result = await call(tools, 'save_draft', {
      to: 'ada@example.com',
      subject: 'Hello',
      body: 'A note',
    });
    expect(result).toMatchObject({
      draftKey: 'k1',
      status: expect.stringContaining('not sent'),
    });
    expect(state.written).toEqual([
      {
        content: {
          from: 'me@yozz.app',
          to: 'ada@example.com',
          cc: '',
          bcc: '',
          subject: 'Hello',
          body: 'A note',
        },
      },
    ]);
  });

  it('needs a recipient and a subject for a new message', async () => {
    const { tools } = fakePort([]);
    await expect(call(tools, 'save_draft', { body: 'A note' })).resolves.toMatchObject({
      error: expect.stringContaining('`to`'),
    });
  });

  it('refuses to send as an address the user does not own', async () => {
    const { tools } = fakePort([]);
    await expect(
      call(tools, 'save_draft', {
        from: 'someone@else.com',
        to: 'a@b.co',
        subject: 's',
        body: 'b',
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining('get_addresses') });
  });

  it('replies with the quote, the recipients and the chain the Reply button would use', async () => {
    const { tools, state } = fakePort([thread('a', ['inbox'])]);
    const result = await call(tools, 'save_draft', { threadId: 'a', body: 'On it.' });
    expect(result).toMatchObject({ threadId: 'a' });
    const [written] = state.written as [{ content: DraftRecord }];
    expect(written.content).toMatchObject({
      to: 'ada@example.com',
      subject: 'Re: Subject a',
      threadId: 'a',
      inReplyTo: '<a/1@example.com>',
      references: ['<a/1@example.com>'],
    });
    expect(written.content.body.startsWith('On it.')).toBe(true);
    // The original is quoted below.
    expect(written.content.body).toContain('> Hello there.');
  });

  it('refuses a replyToMessageId the conversation does not have', async () => {
    // Falling back to the newest message would answer something the caller did not choose.
    const { tools, state } = fakePort([thread('a', ['inbox'])]);
    await expect(
      call(tools, 'save_draft', { threadId: 'a', replyToMessageId: 'a/9', body: 'On it.' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('a/9') });
    expect(state.written).toEqual([]);
  });

  it('files a reply under the account that holds the conversation', async () => {
    // The sending address may have no mailbox of its own.
    const { tools, state } = fakePort([thread('a', ['inbox'])]);
    await call(tools, 'save_draft', { from: 'alias@yozz.app', threadId: 'a', body: 'On it.' });
    expect(state.written).toMatchObject([
      { content: { from: 'alias@yozz.app', ownerAccount: 'me@yozz.app' } },
    ]);
  });

  it('replaces a whole draft, keeping the fields it was not given', async () => {
    const { tools, state } = fakePort([]);
    state.drafts.push(handle('k1'));
    const result = await call(tools, 'save_draft', { draftId: 'k1@2', body: 'A better start' });
    expect(result).toMatchObject({ draftKey: 'k1', draftId: 'k1@3' });
    expect(state.written).toEqual([
      {
        draftId: 'k1@2',
        content: expect.objectContaining({ subject: 'Half written', body: 'A better start' }),
      },
    ]);
  });

  it('says which version won when another device moved the draft on', async () => {
    const { tools, state } = fakePort([], {
      writeDraft: async () => ({ ok: false, reason: 'conflict', currentDraftId: 'k1@7' }),
    });
    state.drafts.push(handle('k1'));
    await expect(
      call(tools, 'save_draft', { draftId: 'k1@2', body: 'mine' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('k1@7') });
  });

  it('stands back when the user has the draft open', async () => {
    const { tools, state } = fakePort([], {
      writeDraft: async () => ({ ok: false, reason: 'busy' }),
    });
    state.drafts.push(handle('k1'));
    await expect(
      call(tools, 'save_draft', { draftId: 'k1@2', body: 'mine' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('composer') });
  });

  it('deletes a draft and says it is recoverable', async () => {
    const { tools } = fakePort([]);
    await expect(call(tools, 'delete_draft', { draftId: 'k1@2' })).resolves.toMatchObject({
      outcome: 'deleted',
      draftId: 'k1@2-tombstone',
      status: expect.stringContaining('30 days'),
    });
  });

  it('reports a draft that is being sent rather than deleting it', async () => {
    const { tools } = fakePort([], { removeDraft: async () => ({ outcome: 'sending' }) });
    await expect(call(tools, 'delete_draft', { draftId: 'k1@2' })).resolves.toMatchObject({
      error: expect.stringContaining('being sent'),
    });
  });
});

describe('navigate', () => {
  it('opens a conversation and marks it read, as the user’s own click would', async () => {
    const { tools, port } = fakePort([thread('a', ['inbox'])]);
    await expect(call(tools, 'navigate', { target: 'thread', threadId: 'a' })).resolves.toEqual({
      ok: true,
      showing: 'thread',
      id: 'a',
    });
    expect(port.openThread).toHaveBeenCalled();
    expect(port.markRead).toHaveBeenCalledWith('a');
  });

  it('opens a draft the vault holds, and refuses one it does not', async () => {
    const { tools, port, state } = fakePort([]);
    state.drafts.push(handle('k1'));
    await expect(
      call(tools, 'navigate', { target: 'composer', draftKey: 'k1' }),
    ).resolves.toMatchObject({ ok: true, showing: 'composer', draftId: 'k1@2' });
    expect(port.openDraft).toHaveBeenCalledWith('k1');

    await expect(
      call(tools, 'navigate', { target: 'composer', draftKey: 'gone' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('gone') });
  });

  it('does nothing more once the session ended during the navigation', async () => {
    const navigation = Promise.withResolvers<void>();
    const { tools, port, state, endSession } = fakePort([thread('a', ['inbox'])], {
      openThread: () => navigation.promise,
      openDraft: () => navigation.promise,
    });
    state.drafts.push(handle('k1'));
    const opened = call(tools, 'navigate', { target: 'thread', threadId: 'a' });
    const composed = call(tools, 'navigate', { target: 'composer', draftKey: 'k1' });
    endSession();
    navigation.resolve();
    await expect(opened).resolves.toEqual({ error: expect.stringContaining('locked') });
    await expect(composed).resolves.toEqual({ error: expect.stringContaining('locked') });
    expect(port.markRead).not.toHaveBeenCalled();
  });

  it('names a conversation that is not cached', async () => {
    const { tools } = fakePort([]);
    await expect(
      call(tools, 'navigate', { target: 'thread', threadId: 'ghost' }),
    ).resolves.toMatchObject({ error: expect.stringContaining('ghost') });
  });
});
