// @vitest-environment jsdom

import type { ImapMessageSummary } from '@yozz.app/imap';
import { createServerSearch, type ServerSearch } from '@yozz.app/mail/threads/server-search';
import type { Folder, ThreadState } from '@yozz.app/mail/threads/thread';
import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddressRail } from '../addresses/AddressRail';
import { SearchRow } from './SearchRow';
import { useListing, useSearchFollowsUrl } from './use-listing';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The URL, as far as the box reads and writes it. */
const url = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    current: { view: 'unified', q: undefined as string | undefined },
    pushes: 0,
    replaces: 0,
  };
  return {
    state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: () => state.current,
    /** The router commits a navigation after the render its keystroke caused. */
    later: (commit: () => void) => setTimeout(commit, 0),
    go: (next: { view: string; q: string | undefined }, replace: boolean) => {
      state.current = next;
      state.replaces += replace ? 1 : 0;
      state.pushes += replace ? 0 : 1;
      for (const listener of listeners) listener();
    },
    open: (view: string, q?: string) => {
      state.current = { view, q };
      state.pushes = 0;
      state.replaces = 0;
    },
    reload: () => {
      for (const listener of listeners) listener();
    },
  };
});

vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore: useStore } = await import('react');
  const useUrl = () => useStore(url.subscribe, url.read);
  return {
    useParams: () => ({ view: useUrl().view }),
    useSearch: () => ({ q: useUrl().q }),
    useLocation: () => false,
    useNavigate:
      () =>
      ({
        params,
        search,
        replace,
      }: {
        params: { view: string };
        search: (previous: { q?: string }) => { q?: string };
        replace: boolean;
      }) =>
        url.later(() => url.go({ view: params.view, q: search({ q: url.read().q }).q }, replace)),
    Link: ({
      children,
      'aria-current': current,
      params,
      search,
    }: {
      children?: React.ReactNode;
      'aria-current'?: 'page';
      params?: { view: string };
      search?: unknown;
    }) => (
      <a
        href="https://yozz.test"
        aria-current={current}
        data-view={params?.view}
        onClick={event => {
          event.preventDefault();
          if (params !== undefined && search !== undefined) {
            url.go({ view: params.view, q: undefined }, false);
          }
        }}
      >
        {children}
      </a>
    ),
  };
});

const copy = (folder: Folder) => ({ mailbox: 'me@x.co', folder, uidValidity: 1, uid: 1 });
const thread = (id: string, folder: Folder, subject = `stripe ${id}`): ThreadState => ({
  id,
  mailboxes: ['me@x.co'],
  subject,
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders: [folder],
  foldersByMailbox: { 'me@x.co': [folder] },
  messages: [
    {
      id: `${id}/1`,
      fromName: 'x',
      fromAddress: 'x@x.co',
      toAddress: 'me@x.co',
      at: 1,
      body: [],
      locations: [copy(folder)],
    },
  ],
});
const THREADS = [
  thread('in-inbox', 'inbox'),
  thread('in-archive', 'archive'),
  thread('in-trash', 'trash'),
  thread('elsewhere', 'inbox', 'lunch'),
];

const asked = vi.hoisted(() => ({ calls: [] as { words: string; signal: AbortSignal }[] }));
const mailboxes = [{ address: 'me@x.co', imap: { host: 'imap.x.co' } }];

let notify = () => {};
let serverSearch: ServerSearch | null = null;
const search = createServerSearch({
  mailboxes: () => mailboxes,
  searchOn: async (_mailbox, { query, signal }) => {
    asked.calls.push({ words: query.terms.map(({ text }) => text).join(' '), signal });
    return { ok: true, value: null as ImapMessageSummary | null };
  },
  moreOn: async (_mailbox, { previous }) => ({ ok: true, value: previous }),
  onChange: next => {
    serverSearch = next;
    notify();
  },
  // Read when called: this module loads before the tests take over the clock.
  setTimer: ((run: () => void, ms: number) => setTimeout(run, ms)) as typeof setTimeout,
  clearTimer: id => clearTimeout(id),
});

// Stable, as the store's is: `useSearchFollowsUrl` hears it when the URL moves, not on every render.
const followSearch = (q: string | undefined) => {
  if (q === undefined) {
    search.stop();
  } else if (search.query() !== q.trim()) {
    search.now(q);
  }
};

vi.mock('../store/MailProvider', () => ({
  useMail: () => {
    const current = useSyncExternalStore(
      listener => {
        notify = listener;
        return () => {};
      },
      () => serverSearch,
    );
    return {
      threads: THREADS,
      mailboxes,
      windows: [],
      serverSearch: current,
      syncStates: {},
      mailError: null,
      sentCopyError: null,
      search,
      sync: vi.fn(),
      junkFolders: {},
      followSearch,
    };
  },
}));
vi.mock('../compose/intent', () => ({
  keepCompose: {},
  withCompose: () => ({}),
}));

const App = () => {
  useSearchFollowsUrl();
  const listing = useListing();
  if (listing === undefined) return null;
  return (
    <>
      <AddressRail />
      <SearchRow listing={listing} />
      <ul>
        {listing.threads.map(({ id }) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    </>
  );
};

const host = document.body.appendChild(document.createElement('div'));
const root = createRoot(host);
const box = () => {
  const found = host.querySelector<HTMLTextAreaElement>('[role="searchbox"]');
  if (found === null) throw new Error('No search box');
  return found;
};
/** A keystroke, and the render it causes: the router has not committed its URL yet. */
const keystroke = (value: string, caret = value.length) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(box(), value);
    box().setSelectionRange(caret, caret);
    box().dispatchEvent(new Event('input', { bubbles: true }));
  });
const commit = () => act(async () => vi.advanceTimersByTimeAsync(0));
const type = async (value: string) => {
  await keystroke(value);
  await commit();
};
const press = async (key: string) => {
  await act(async () => {
    box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await commit();
};
const pause = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
const rows = () => [...host.querySelectorAll('li')].map(({ textContent }) => textContent);
const current = () =>
  [...host.querySelectorAll('nav a[aria-current="page"]')].map(link =>
    link.getAttribute('data-view'),
  );
const clickRail = (view: string) =>
  act(async () => {
    [...host.querySelectorAll(`nav a[data-view="${view}"]`)]
      .at(-1)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
const open = (view = 'unified', q?: string) => {
  url.open(view, q);
  return act(async () => root.render(<App />));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  asked.calls = [];
});

afterEach(async () => {
  search.stop();
  await act(async () => root.render(null));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the search box', () => {
  it('shows the query of the list it stands over', async () => {
    await open();
    expect(box().value).toBe('in:inbox');
    await open('trash');
    expect(box().value).toBe('in:trash');
    await open('me@x.co');
    expect(box().value).toBe('in:inbox mailbox:me@x.co');
  });

  it('searches everything but Trash once in:inbox is gone, Archive included', async () => {
    await open();
    expect(rows()).toEqual(['in-inbox', 'elsewhere']);
    await type('stripe');
    expect(rows()).toEqual(['in-inbox', 'in-archive']);
    expect(url.read()).toEqual({ view: 'unified', q: 'stripe' });
  });

  it('accepts in:inbox stripe as the inbox only', async () => {
    await open();
    await type('in:inbox stripe');
    expect(rows()).toEqual(['in-inbox']);
  });

  it('keeps an empty box empty on Enter, with everything but Trash and nothing lit', async () => {
    await open();
    expect(current()).toContain('unified');
    await type('');
    expect(current()).toEqual([]);
    expect(rows()).toEqual(['in-inbox', 'in-archive', 'elsewhere']);

    await press('Enter');
    await pause(5000);
    expect(box().value).toBe('');
    expect(current()).toEqual([]);
    expect(rows()).toEqual(['in-inbox', 'in-archive', 'elsewhere']);
    expect(asked.calls).toEqual([]);
  });

  it('gets back to Inbox by clicking it, or by typing its query', async () => {
    await open();
    await type('');
    await clickRail('unified');
    expect(box().value).toBe('in:inbox');
    expect(current()).toContain('unified');

    await type('');
    await type('in:inbox');
    expect(current()).toContain('unified');
    expect(rows()).toEqual(['in-inbox', 'elsewhere']);
  });

  it('lights the row whose own query the box holds, and none for anything else', async () => {
    await open('sent');
    await type('in:trash');
    expect(current()).toContain('trash');
    await type('in:trash stripe');
    expect(current()).toEqual([]);
  });

  it('lets no line break in: Enter is not one, and a pasted one becomes a space', async () => {
    await open();
    await type('one\ntwo\r\n  three');
    expect(box().value).toBe('one two three');
    await press('Enter');
    expect(box().value).toBe('one two three');
  });

  it('leaves the text alone on Escape', async () => {
    await open();
    await type('stripe');
    await press('Escape');
    expect(box().value).toBe('stripe');
  });
});

describe('the box as a text field, with the URL committing later', () => {
  it('keeps the text and the caret where typing left them in the middle of a query', async () => {
    await open('unified', 'receipt stripe');
    await keystroke('recexipt stripe', 5);
    expect(box().value).toBe('recexipt stripe');
    expect(box().selectionStart).toBe(5);
    await commit();
    expect(url.read().q).toBe('recexipt stripe');
    expect(box().value).toBe('recexipt stripe');
    expect(box().selectionStart).toBe(5);
    await keystroke('recexypt stripe', 6);
    await commit();
    expect(box().value).toBe('recexypt stripe');
    expect(box().selectionStart).toBe(6);
  });

  it('does the same over a view, whose query is not in the URL', async () => {
    await open('unified');
    await keystroke('in:xinbox', 4);
    expect(box().value).toBe('in:xinbox');
    expect(box().selectionStart).toBe(4);
    await commit();
    expect(box().value).toBe('in:xinbox');
    expect(box().selectionStart).toBe(4);
  });

  it('holds what was typed through a URL that is behind by several keystrokes', async () => {
    await open('unified', 'a');
    await keystroke('ab');
    await keystroke('abc');
    await keystroke('abcd');
    expect(box().value).toBe('abcd');
    await commit();
    expect(url.read().q).toBe('abcd');
    expect(box().value).toBe('abcd');
  });

  it('ends on what is in the box when a keystroke goes back to what the URL still says', async () => {
    await open('unified', 'a');
    await keystroke('ab');
    await keystroke('a');
    await commit();
    expect(url.read().q).toBe('a');
    expect(box().value).toBe('a');
  });

  it('gives the box up when the list moves on by another road, focus or no focus', async () => {
    await open('unified', 'first');
    await type('second');
    await act(async () => url.go({ view: 'unified', q: 'first' }, false));
    expect(box().value).toBe('first');
    await type('third');
    expect(box().value).toBe('third');
    await act(async () => url.go({ view: 'starred', q: undefined }, false));
    expect(box().value).toBe('is:starred');
  });
});

describe('asking the servers', () => {
  it('waits for a pause in typing, then asks for what is in the box', async () => {
    await open();
    await type('st');
    await pause(500);
    await type('stripe');
    await pause(999);
    expect(asked.calls).toEqual([]);
    await pause(1);
    expect(asked.calls.map(({ words }) => words)).toEqual(['stripe']);
  });

  it('drops the search a new keystroke supersedes', async () => {
    await open();
    await type('stripe');
    await pause(1000);
    await type('stripe x');
    expect(asked.calls[0]?.signal.aborted).toBe(true);
  });

  it('skips the wait on Enter, and asks once', async () => {
    await open();
    await type('stripe');
    await press('Enter');
    expect(asked.calls.map(({ words }) => words)).toEqual(['stripe']);
    await pause(5000);
    expect(asked.calls).toHaveLength(1);
  });

  it('asks nothing for a query that only says where', async () => {
    await open();
    await type('mailbox:me@x.co');
    await press('Enter');
    await pause(5000);
    expect(asked.calls).toEqual([]);
  });

  it('asks the servers at once when a ?q= link opens', async () => {
    await open('unified', 'stripe');
    expect(asked.calls.map(({ words }) => words)).toEqual(['stripe']);
    expect(box().value).toBe('stripe');
  });

  it('asks nothing when a link names a view’s own query or an empty one', async () => {
    await open('unified', 'in:trash');
    expect(box().value).toBe('in:trash');
    await open('unified', '');
    expect(box().value).toBe('');
    expect(asked.calls).toEqual([]);
  });
});

describe('history', () => {
  it('adds one Back entry for the first keystroke, and replaces it after', async () => {
    await open();
    await type('s');
    await type('st');
    await type('str');
    expect(url.state.pushes).toBe(1);
    expect(url.state.replaces).toBe(2);
  });
});
