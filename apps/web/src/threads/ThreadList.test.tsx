// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ThreadList } from './ThreadList';
import type { ThreadState } from './thread';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mail = vi.hoisted(() => ({
  accounts: [{ address: 'me@example.com', imap: { host: 'imap.example.com' } }],
  ownedAddresses: ['me@example.com'],
  recordsError: null,
  syncStates: {},
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
  flagThreads: vi.fn(
    (threadIds: readonly string[], _key: string, _value: boolean) => new Set(threadIds),
  ),
  removeDraft: vi.fn(async (_draftId: string) => ({ outcome: 'deleted' as const })),
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
}));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));
vi.mock('./use-advance', () => ({ useAdvancePast: () => vi.fn() }));

const threadNumbered = (index: number): ThreadState => ({
  id: `thread-${index}`,
  accounts: ['me@example.com'],
  subject: `Subject ${index}`,
  folders: ['inbox'],
  foldersByAccount: { 'me@example.com': ['inbox'] },
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
      locations: [{ account: 'me@example.com', folder: 'inbox', uidValidity: 1, uid: index + 1 }],
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
  for (const [target, key, stub] of layout) {
    Object.defineProperty(target, key, { ...stub, configurable: true });
  }
});
afterAll(() => {
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
const show = (threads: readonly ThreadState[], query = '', mailbox = 'unified') =>
  act(async () =>
    root.render(
      <ThreadList threads={threads} mailbox={mailbox} query={query} onQueryChange={() => {}} />,
    ),
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
  it('puts a screenful of a long mailbox in the DOM, each row saying where it sits in the whole', async () => {
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

  it('turns the search bar into actions for the ticked rows, with a mixed box over them', async () => {
    await show(FEW);
    expect(host.querySelector('input[type="search"]')).not.toBeNull();

    await click(boxOf('Subject 1'));
    expect(host.querySelector('input[type="search"]')).toBeNull();
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
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
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
    const archived = FEW.map(thread => ({ ...thread, folders: ['archive', 'inbox'] as const }));
    await show(archived, '', 'archive');
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
    expect(route.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/m/$mailbox' }));
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
    await show([twoDrafts], '', 'drafts');
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

  it('says a search matched nothing', async () => {
    await show([], 'nonexistent');
    expect(host.textContent).toContain('No mail matches “nonexistent”.');
  });
});
