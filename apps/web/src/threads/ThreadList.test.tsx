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
  toggleArchive: vi.fn(),
  trashThread: vi.fn(),
  restoreThread: vi.fn(),
  removeDraft: vi.fn(),
}));

const route = vi.hoisted(() => ({ splat: undefined as string | undefined }));

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
const show = (threads: readonly ThreadState[], query = '') =>
  act(async () =>
    root.render(
      <ThreadList threads={threads} mailbox="unified" query={query} onQueryChange={() => {}} />,
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

afterEach(async () => {
  route.splat = undefined;
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

  it('says a search matched nothing', async () => {
    await show([], 'nonexistent');
    expect(host.textContent).toContain('No mail matches “nonexistent”.');
  });
});
