// @vitest-environment jsdom

import type { ServerSearch } from '@yozz.app/mail/threads/server-search';
import type { ThreadState } from '@yozz.app/mail/threads/thread';
import type { Listing } from '@yozz.app/mail/threads/views';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ThreadList } from './ThreadList';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mail = vi.hoisted(() => ({
  mailboxes: [{ address: 'me@example.com', imap: { host: 'imap.example.com' } }],
  ownedAddresses: ['me@example.com'],
  recordsError: null,
  syncStates: {} as Record<string, unknown>,
  sync: vi.fn(),
  loadOlder: vi.fn(),
  isLoadingOlder: () => false,
  isDemo: true,
  toggleStar: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  toggleArchive: vi.fn((_threadId: string) => true),
  trashThread: vi.fn(),
  restoreThread: vi.fn((_threadId: string) => true),
  moveThreads: vi.fn((threadIds: readonly string[], _to: string) => new Set(threadIds)),
  junkFolders: { 'me@example.com': true } as Record<string, boolean>,
  flagThreads: vi.fn(
    (threadIds: readonly string[], _key: string, _value: boolean) => new Set(threadIds),
  ),
  removeDraft: vi.fn(async (_draftId: string) => ({ outcome: 'deleted' as const })),
  serverSearch: null as ServerSearch | null,
  search: { type: vi.fn(), now: vi.fn(), retry: vi.fn() },
  loadOlderInList: vi.fn(),
  isLoadingOlderInList: false,
  mailError: null as string | null,
  sentCopyError: null as string | null,
}));

const route = vi.hoisted(() => ({ splat: undefined as string | undefined, navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    'aria-label': ariaLabel,
    'aria-current': ariaCurrent,
  }: {
    children?: React.ReactNode;
    'aria-label'?: string;
    'aria-current'?: boolean;
  }) => (
    <a href="https://yozz.test" aria-label={ariaLabel} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
  useParams: () => ({ _splat: route.splat }),
  useNavigate: () => route.navigate,
  useSearch: () => ({}),
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));
vi.mock('./use-advance', () => ({ useAdvancePast: () => vi.fn() }));

const threadNumbered = (index: number): ThreadState => ({
  id: `thread-${index}`,
  mailboxes: ['me@example.com'],
  subject: `Subject ${index}`,
  folders: ['inbox'],
  foldersByMailbox: { 'me@example.com': ['inbox'] },
  isUnread: false,
  isReplied: false,
  isStarred: false,
  messages: [
    {
      id: `message-${index}`,
      fromName: `Sender ${index}`,
      fromAddress: `sender${index}@example.org`,
      toAddress: 'me@example.com',
      at: 1_700_000_000_000 - index * 60_000,
      body: [],
      locations: [{ mailbox: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: index + 1 }],
    },
  ],
});
const MAILBOX = Array.from({ length: 2_000 }, (_, index) => threadNumbered(index));

// jsdom lays nothing out and cannot scroll: a 600px list of 34px rows, and `scrollTo` as a browser has it.
const ROW_HEIGHT = 34;
const layout: [object, string, PropertyDescriptor][] = [
  [
    HTMLElement.prototype,
    'offsetHeight',
    {
      get(this: HTMLElement) {
        return this instanceof HTMLLIElement ? ROW_HEIGHT : 600;
      },
    },
  ],
  [Element.prototype, 'scrollHeight', { get: () => MAILBOX.length * ROW_HEIGHT }],
  [
    Element.prototype,
    'scrollTo',
    {
      value(this: Element, { top }: ScrollToOptions) {
        this.scrollTop = top ?? this.scrollTop;
        this.dispatchEvent(new Event('scroll'));
      },
    },
  ],
];
const jsdom = layout.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  for (const [target, key, stub] of layout) {
    Object.defineProperty(target, key, { ...stub, configurable: true });
  }
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const [index, [target, key]] of layout.entries()) {
    const original = jsdom[index];
    if (original === undefined) {
      Reflect.deleteProperty(target, key);
      continue;
    }
    Object.defineProperty(target, key, original);
  }
});

const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
const show = (
  threads: readonly ThreadState[],
  query = 'in:inbox',
  view = 'unified',
  isSearch = false,
  older: Listing['older'] = null,
) =>
  act(async () =>
    root.render(<ThreadList listing={{ threads, view, query, isSearch, error: null, older }} />),
  );
const scroller = () => {
  const list = host.querySelector('ul')?.parentElement;
  if (list == null) throw new Error('No list on screen');
  return list;
};
const scrollTo = (top: number) =>
  act(async () => {
    scroller().scrollTop = top;
    scroller().dispatchEvent(new Event('scroll'));
  });
const rowOf = (subject: string) =>
  host.querySelector(`a[aria-label*=": ${subject}."]`)?.closest('li') ?? null;

const boxOf = (subject: string) => {
  const box = rowOf(subject)?.querySelector<HTMLInputElement>(
    `input[aria-label="Select ${subject}"]`,
  );
  if (box == null) throw new Error(`No box on ${subject}`);
  return box;
};
const click = (element: Element, init: MouseEventInit = {}) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  });
const button = (label: string) => {
  const found = [...host.querySelectorAll('button')].find(
    candidate => candidate.ariaLabel === label || candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`No ${label} button`);
  return found;
};
const tickedSubjects = () =>
  [...host.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]:checked')].map(box =>
    box.ariaLabel?.replace('Select ', ''),
  );
const FEW = MAILBOX.slice(0, 5);

afterEach(async () => {
  route.splat = undefined;
  mail.moveThreads.mockClear();
  mail.flagThreads.mockClear();
  route.navigate.mockClear();
  mail.removeDraft.mockClear();
  await act(async () => root.render(null));
});

describe('ThreadList', () => {
  it('puts a screenful of a long view in the DOM, each row saying where it sits in the whole', async () => {
    await show(MAILBOX);
    const rows = [...host.querySelectorAll('li')];
    expect(rows.length).toBeLessThan(50);
    expect(rows[0]?.getAttribute('aria-posinset')).toBe('1');
    expect(rows.every(row => row.getAttribute('aria-setsize') === '2000')).toBe(true);
    expect(rowOf('Subject 1500')).toBeNull();

    await scrollTo(1_500 * ROW_HEIGHT);
    expect(rowOf('Subject 1500')?.getAttribute('aria-posinset')).toBe('1501');
  });

  it('scrolls the thread a link opens into view', async () => {
    route.splat = 'thread-1500';
    await show(MAILBOX);
    expect(rowOf('Subject 1500')?.querySelector('a')?.ariaCurrent).toBe('true');
  });

  it('leaves the list where it was scrolled when a sync changes it under the open thread', async () => {
    route.splat = 'thread-0';
    await show(MAILBOX);
    await scrollTo(1_000 * ROW_HEIGHT);
    await show([threadNumbered(-1), ...MAILBOX]);
    expect(scroller().scrollTop).toBe(1_000 * ROW_HEIGHT);
  });

  it('keeps the focused row, and its focus, when the list scrolls past it', async () => {
    await show(MAILBOX);
    const link = rowOf('Subject 0')?.querySelector('a');
    act(() => link?.focus());
    expect(document.activeElement).toBe(link);

    await scrollTo(1_000 * ROW_HEIGHT);
    expect(rowOf('Subject 1000')).not.toBeNull();
    expect(document.activeElement).toBe(link);
  });

  it('offers actions for the ticked rows under a box that stays, with a mixed box over them', async () => {
    await show(FEW);
    await click(boxOf('Subject 1'));
    expect(host.querySelector('[role="searchbox"]')).not.toBeNull();
    const all = host.querySelector<HTMLInputElement>('input[aria-label="Clear the selection"]');
    expect(all?.indeterminate).toBe(true);
    expect(button('Archive')).toBeDefined();
  });

  it('ticks a range on a Shift-click', async () => {
    await show(FEW);
    await click(boxOf('Subject 1'));
    await click(boxOf('Subject 3'), { shiftKey: true });
    expect(tickedSubjects()).toEqual(['Subject 1', 'Subject 2', 'Subject 3']);
  });

  it('clears every tick from the box over the list', async () => {
    await show(FEW);
    await click(boxOf('Subject 1'));
    await click(boxOf('Subject 2'));
    const all = host.querySelector('input[aria-label="Clear the selection"]');
    if (all === null) throw new Error('No box over the list');
    await click(all);
    expect(tickedSubjects()).toEqual([]);
  });

  it('archives every ticked row, then clears the selection', async () => {
    await show(FEW);
    await click(boxOf('Subject 0'));
    await click(boxOf('Subject 4'));
    await click(button('Archive'));
    // One write for the whole batch.
    expect(mail.moveThreads.mock.calls.map(([ids, to]) => [ids, to])).toEqual([
      [['thread-0', 'thread-4'], 'archive'],
    ]);
    expect(tickedSubjects()).toEqual([]);
  });

  it('moves ticked rows back to the inbox from Archive, whatever else they hold', async () => {
    const archived = FEW.map(thread => ({ ...thread, folders: ['archive', 'sent'] as const }));
    await show(archived, 'in:archive', 'archive');
    await click(boxOf('Subject 1'));
    await click(button('Move to inbox'));
    expect(mail.moveThreads.mock.calls.map(([ids, to]) => [ids, to])).toEqual([
      [['thread-1'], 'inbox'],
    ]);
  });

  it('closes the open message when marking it unread with others, or it would be read again', async () => {
    route.splat = 'thread-0';
    await show(FEW);
    await click(boxOf('Subject 0'));
    await click(boxOf('Subject 1'));
    await click(button('Mark as unread'));
    expect(mail.flagThreads.mock.calls).toEqual([[['thread-0', 'thread-1'], 'isUnread', true]]);
    expect(route.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/m/$view' }));
  });

  it('does not bring back the ticks from before a message was opened when it closes', async () => {
    await show(FEW);
    await click(boxOf('Subject 1'));
    route.splat = 'thread-3';
    await show(FEW);
    route.splat = undefined;
    await show(FEW);
    expect(tickedSubjects()).toEqual([]);
  });

  it('keeps Cancel while selecting after a sync empties the list', async () => {
    await show(FEW);
    await click(button('Select'));
    await show([]);
    expect(button('Cancel')).toBeDefined();
  });

  it('discards every draft in each ticked conversation', async () => {
    const [first] = FEW;
    if (first === undefined) throw new Error('No thread');
    const draft = (draftId: string) => ({
      ...first.messages[0],
      id: draftId,
      isDraft: true,
      draftId,
    });
    const twoDrafts = { ...first, messages: [draft('d-1'), draft('d-2')] } as ThreadState;
    await show([twoDrafts], 'in:drafts', 'drafts');
    await click(boxOf('Subject 0'));
    await click(button('Discard drafts'));
    const confirm = [...document.querySelectorAll('button')].find(
      candidate => candidate.textContent === 'Discard',
    );
    if (confirm === undefined) throw new Error('No confirm');
    await act(async () => {
      confirm.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(mail.removeDraft.mock.calls.map(([id]) => id)).toEqual(['d-1', 'd-2']);
  });

  describe('what is offered goes by what the conversations hold, wherever they are listed', () => {
    const [plain] = FEW;
    if (plain === undefined) throw new Error('No thread');
    const holding = (
      folders: readonly ThreadState['folders'][number][],
      index = 0,
    ): ThreadState => {
      const thread = FEW[index];
      if (thread === undefined) throw new Error(`No thread at ${index}`);
      return {
        ...thread,
        folders,
        foldersByMailbox: Object.fromEntries(thread.mailboxes.map(mailbox => [mailbox, folders])),
      };
    };
    const withDraft = (thread: ThreadState, hasServerCopy: boolean): ThreadState => {
      const [message] = thread.messages;
      if (message === undefined) throw new Error('No message');
      return {
        ...thread,
        folders: hasServerCopy ? [...thread.folders, 'drafts'] : ['drafts'],
        messages: [
          ...(hasServerCopy ? [message] : []),
          { ...message, id: 'draft', isDraft: true, draftId: 'd-1', locations: [] },
        ],
      };
    };
    const offered = () =>
      [...host.querySelectorAll('button')].flatMap(({ ariaLabel }) =>
        ariaLabel === null ? [] : [ariaLabel],
      );
    const movedTo = () => mail.moveThreads.mock.calls.map(([ids, to]) => [ids, to]);

    it('moves ticked archived hits back to the inbox under a search', async () => {
      await show([holding(['archive'])], 'stripe', 'unified', true);
      await click(boxOf('Subject 0'));
      await click(button('Move to inbox'));
      expect(movedTo()).toEqual([[['thread-0'], 'inbox']]);
    });

    it('offers each action to the ticked threads it applies to, in a mixed set', async () => {
      await show([holding(['inbox']), holding(['archive'], 1)], 'stripe', 'unified', true);
      await click(boxOf('Subject 0'));
      await click(boxOf('Subject 1'));
      await click(button('Archive'));
      expect(movedTo()).toEqual([[['thread-0'], 'archive']]);

      mail.moveThreads.mockClear();
      await click(boxOf('Subject 0'));
      await click(boxOf('Subject 1'));
      await click(button('Move to inbox'));
      expect(movedTo()).toEqual([[['thread-1'], 'inbox']]);
    });

    it('moves ticked mail to Junk, and ticked Junk back to the inbox', async () => {
      await show([holding(['inbox']), holding(['junk'], 1)], 'stripe', 'unified', true);
      await click(boxOf('Subject 0'));
      await click(boxOf('Subject 1'));
      await click(button('Move to Junk'));
      expect(movedTo()).toEqual([[['thread-0'], 'junk']]);

      mail.moveThreads.mockClear();
      await click(boxOf('Subject 0'));
      await click(boxOf('Subject 1'));
      await click(button('Move to inbox'));
      expect(movedTo()).toEqual([[['thread-1'], 'inbox']]);
    });

    it('keeps Archive beside Restore for a half-trashed thread, as its row does', async () => {
      await show([holding(['inbox', 'trash'])], 'stripe', 'unified', true);
      expect(offered()).toEqual(
        expect.arrayContaining(['Restore Subject 0', 'Archive Subject 0', 'Delete Subject 0']),
      );
      await click(boxOf('Subject 0'));
      expect(offered()).toEqual(expect.arrayContaining(['Restore', 'Archive', 'Delete']));
      expect(offered()).not.toContain('Move to inbox');
    });

    it('offers only Restore for a thread all in Trash', async () => {
      await show([holding(['trash'])], 'stripe', 'unified', true);
      await click(boxOf('Subject 0'));
      expect(offered()).toContain('Restore');
      expect(offered()).not.toContain('Archive');
      expect(offered()).not.toContain('Delete');
    });

    it('offers Discard for a draft-only hit, on its row and in the bar', async () => {
      await show([withDraft(plain, false)], 'stripe', 'unified', true);
      expect(offered()).toContain('Discard Subject 0');
      await click(boxOf('Subject 0'));
      expect(offered()).toContain('Discard drafts');
    });

    it('keeps a draft with a server copy to its moves outside Drafts, on its row and in the bar', async () => {
      await show([withDraft(plain, true)], 'stripe', 'unified', true);
      expect(offered()).toContain('Archive Subject 0');
      expect(offered()).not.toContain('Discard Subject 0');
      await click(boxOf('Subject 0'));
      expect(offered()).toContain('Archive');
      expect(offered()).not.toContain('Discard drafts');
    });

    it('offers Discard to the draft-only thread beside the moves of the rest', async () => {
      const onServer = holding(['inbox'], 1);
      await show([withDraft(plain, false), onServer], 'stripe', 'unified', true);
      await click(boxOf('Subject 0'));
      await click(boxOf('Subject 1'));
      expect(offered()).toEqual(expect.arrayContaining(['Archive', 'Discard drafts']));
    });

    it('leaves Drafts as it was: only Discard, even for a conversation on a server', async () => {
      await show([withDraft(plain, true)], 'in:drafts', 'drafts');
      expect(offered()).toContain('Discard Subject 0');
      expect(offered()).not.toContain('Archive Subject 0');
      await click(boxOf('Subject 0'));
      expect(offered()).toContain('Discard drafts');
      expect(offered()).not.toContain('Archive');
    });

    it('leaves Archive as it was: Move to inbox, not Archive', async () => {
      await show([holding(['archive'])], 'in:archive', 'archive');
      await click(boxOf('Subject 0'));
      expect(offered()).toContain('Move to inbox');
      expect(offered()).not.toContain('Archive');
    });
  });

  it('keeps the open row current while its bar gives way to a tick, and clears ticks on opening another', async () => {
    route.splat = 'thread-0';
    await show(FEW);
    await click(boxOf('Subject 2'));
    expect(rowOf('Subject 0')?.querySelector('a')?.ariaCurrent).toBe('true');
    expect(rowOf('Subject 0')?.firstElementChild?.className).not.toContain('bg-select');

    route.splat = 'thread-3';
    await show(FEW);
    expect(tickedSubjects()).toEqual([]);
  });

  it('ticks a row with a tap anywhere on it once Select is on, and Cancel clears the ticks and leaves', async () => {
    await show(FEW);
    await click(button('Select'));
    const tapTarget = rowOf('Subject 2')?.querySelector('button[aria-hidden="true"]');
    if (tapTarget == null) throw new Error('No tap target');
    await click(tapTarget);
    expect(tickedSubjects()).toEqual(['Subject 2']);

    await click(button('Cancel'));
    expect(tickedSubjects()).toEqual([]);
    expect(host.querySelector('li button[aria-hidden="true"]')).toBeNull();
  });

  describe('saying what a search has reached', () => {
    const asking = (
      phase: ServerSearch['phase'],
      over: Partial<ServerSearch> = {},
    ): ServerSearch => ({
      query: 'nonexistent',
      phase,
      asking: phase === 'asking' ? ['me@example.com'] : [],
      answers: [],
      failed: [],
      ...over,
    });
    afterEach(() => {
      mail.serverSearch = null;
    });

    it.each(['waiting', 'asking'] as const)(
      'says it is fetching while the servers are %s, not that nothing matched',
      async phase => {
        mail.serverSearch = asking(phase);
        await show([], 'nonexistent', 'unified', true);
        expect(host.textContent).toContain('Fetching more mail…');
        expect(host.textContent).toContain('Fetching…');
        expect(host.textContent).not.toContain('Nothing matches');
      },
    );

    it('says nothing under the box once every server has answered', async () => {
      mail.serverSearch = asking('settled');
      await show(FEW, 'nonexistent', 'unified', true);
      expect(host.textContent).not.toContain('Fetching');
      expect(host.querySelector('p[title]')).toBeNull();
    });

    it('says nothing matches once every server has answered', async () => {
      mail.serverSearch = asking('settled');
      await show([], 'nonexistent', 'unified', true);
      expect(host.textContent).toContain('Nothing matches "nonexistent".');
      expect(host.textContent).not.toContain('Fetching');
    });

    it('never says fetching when no search is under way, as nothing would arrive', async () => {
      await show([], 'nonexistent', 'unified', true);
      expect(host.textContent).toContain('Nothing matches "nonexistent".');
      expect(host.textContent).not.toContain('Fetching');

      // What an older search is doing says nothing about this one.
      mail.serverSearch = { ...asking('asking'), query: 'older' };
      await show([], 'nonexistent', 'unified', true);
      expect(host.textContent).not.toContain('Fetching');
    });

    it('names an address that failed, offers Retry, and keeps what the others found', async () => {
      mail.serverSearch = asking('settled', {
        failed: [{ address: 'me@example.com', failure: { kind: 'stalled' } }],
      });
      await show(FEW, 'nonexistent', 'unified', true);
      expect(host.textContent).toContain(
        "1 of 1 mailbox couldn't be searched. me@example.com may be missing results.",
      );
      expect(rowOf('Subject 1')).not.toBeNull();
      await click(button('Retry'));
      expect(mail.search.retry).toHaveBeenCalled();

      await show([], 'nonexistent', 'unified', true);
      expect(host.textContent).toContain('Nothing matches "nonexistent".');
    });
  });

  describe('the line under the box', () => {
    afterEach(() => {
      Object.assign(mail, {
        syncStates: {},
        mailError: null,
        sentCopyError: null,
        serverSearch: null,
      });
      mail.sync.mockClear();
    });

    it('says nothing while all is well', async () => {
      mail.syncStates = { 'me@example.com': { status: 'synced', at: 1000, complete: [] } };
      await show(FEW);
      expect(host.querySelector('p[title]')).toBeNull();
    });

    it('names a failed sync on any list, and retries that address', async () => {
      mail.syncStates = {
        'me@example.com': { status: 'failed', failure: { kind: 'stalled' }, at: 1000 },
      };
      await show(FEW);
      expect(host.textContent).toContain('imap.example.com stopped responding');
      await click(button('Retry'));
      expect(mail.sync).toHaveBeenCalledWith('me@example.com');
    });

    it('says what a move refused, with nothing to retry', async () => {
      mail.mailError = 'thread not moved · imap.example.com: Archive is read-only';
      await show(FEW);
      expect(host.textContent).toContain('thread not moved · imap.example.com');
      expect(() => button('Retry')).toThrow();
    });

    it('says why a Sent copy failed', async () => {
      mail.sentCopyError = 'Sent copy not saved';
      await show(FEW);
      expect(host.textContent).toContain('Sent copy not saved');
    });

    it('puts what went wrong ahead of what a search is doing', async () => {
      mail.mailError = 'flag not saved · imap.example.com: refused';
      mail.serverSearch = {
        query: 'word',
        phase: 'asking',
        asking: ['me@example.com'],
        answers: [],
        failed: [],
      };
      await show(FEW, 'word', 'unified', true);
      expect(host.textContent).toContain('flag not saved');
      expect(host.textContent).not.toContain('Fetching more mail…');
    });
  });

  describe('the counts', () => {
    const unread = (thread: ThreadState): ThreadState => ({ ...thread, isUnread: true });

    it('stand beside the box while nothing is ticked, and give way to the actions', async () => {
      await show([unread(MAILBOX[0] as ThreadState), ...FEW.slice(1)]);
      expect(host.textContent).toContain('1 unread · 5 conversations');
      await click(boxOf('Subject 1'));
      expect(host.textContent).not.toContain('unread ·');
      expect(button('Archive')).toBeDefined();
    });

    it('say one conversation, not one conversations, and nothing of an unread of zero', async () => {
      await show(FEW.slice(0, 1));
      expect(host.textContent).toContain('1 conversation');
      expect(host.textContent).not.toContain('1 conversations');
      expect(host.textContent).not.toContain('unread');
    });

    it('go with the box and Select when the list is empty', async () => {
      await show([], 'word', 'unified', true);
      expect(host.textContent).not.toContain('conversations');
      expect(host.querySelector('input[aria-label="Select every message"]')).toBeNull();
      expect(() => button('Select')).toThrow();
    });
  });

  it('offers Older mail under a query that only says where, while a folder has more', async () => {
    await show(FEW, '', 'unified', true, {
      mailbox: 'me@example.com',
      folder: 'inbox',
      reachedAt: 1,
    });
    await click(button('Older mail'));
    expect(mail.loadOlderInList).toHaveBeenCalledWith('');
    await show(FEW, '', 'unified', true);
    expect(host.textContent).not.toContain('Older mail');
  });

  it('offers Restore on a trashed row whatever list it is in', async () => {
    const trashed = FEW.map(thread => ({
      ...thread,
      folders: ['trash'] as const,
      foldersByMailbox: { 'me@example.com': ['trash'] as const },
    }));
    await show(trashed, 'in:anywhere stripe', 'unified', true);
    expect(
      rowOf('Subject 1')?.querySelector('button[aria-label="Restore Subject 1"]'),
    ).not.toBeNull();
    expect(rowOf('Subject 1')?.querySelector('button[aria-label="Archive Subject 1"]')).toBeNull();
    await click(boxOf('Subject 1'));
    await click(button('Restore'));
    expect(mail.moveThreads.mock.calls.map(([ids, to]) => [ids, to])).toEqual([
      [['thread-1'], 'inbox'],
    ]);
  });

  it('offers archive and delete beside Restore on a conversation only half in Trash', async () => {
    const half = FEW.map(thread => ({
      ...thread,
      folders: ['inbox', 'trash'] as const,
      foldersByMailbox: { 'me@example.com': ['inbox', 'trash'] as const },
    }));
    await show(half, 'in:anywhere stripe', 'unified', true);
    const row = rowOf('Subject 1');
    for (const label of ['Restore Subject 1', 'Archive Subject 1', 'Delete Subject 1']) {
      expect(row?.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
    }
  });
});
