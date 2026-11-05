import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailConnectionFailure, Result } from '../connection.ts';
import type { FolderMatches } from './found.ts';
import {
  askServers,
  createServerSearch,
  planOf,
  type SearchOn,
  type ServerSearch,
} from './server-search.ts';

const mailboxes = [{ address: 'a@x.co' }, { address: 'b@x.co' }];
const matches = (folder: FolderMatches['folder'], hits: readonly number[]): FolderMatches => ({
  folder,
  uidValidity: 1,
  hits,
  summaries: [],
  folderName: folder,
  rest: [],
  reachedAt: null,
});
const OK: Result<null, MailConnectionFailure> = { ok: true, value: null };

/** A server per address that answers when told to. */
const world = () => {
  const asked: { address: string; signal: AbortSignal; words: string }[] = [];
  const pending = new Map<
    string,
    {
      readonly answer: (result?: Result<unknown, MailConnectionFailure>) => void;
      readonly report: (found: FolderMatches) => void;
    }
  >();
  const searchOn: SearchOn<{ address: string }> = ({ address }, { signal, query, onMatches }) =>
    new Promise(resolve => {
      asked.push({ address, signal, words: query.terms.map(({ text }) => text).join(' ') });
      pending.set(address, { answer: (result = OK) => resolve(result), report: onMatches });
    });
  const states: (ServerSearch | null)[] = [];
  const more: { previous: FolderMatches; signal: AbortSignal }[] = [];
  const moreAnswer: {
    current: Promise<Result<FolderMatches, MailConnectionFailure> | null>;
  } = { current: Promise.resolve(null) };
  const search = createServerSearch({
    mailboxes: () => mailboxes,
    searchOn,
    moreOn: async (_mailbox, { previous, signal }) => {
      more.push({ previous, signal });
      const read = await moreAnswer.current;
      return (
        read ?? { ok: true, value: { ...previous, hits: previous.rest, rest: [], reachedAt: null } }
      );
    },
    onChange: state => states.push(state),
    pauseMs: 1000,
  });
  const landed = async (address: string, result?: Result<unknown, MailConnectionFailure>) => {
    pending.get(address)?.answer(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  return { search, asked, pending, states, landed, more, moreAnswer, last: () => states.at(-1) };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createServerSearch', () => {
  it('asks nothing until typing pauses, and only for the last word', () => {
    const { search, asked, last } = world();
    search.type('i');
    vi.advanceTimersByTime(400);
    search.type('in');
    vi.advanceTimersByTime(999);
    expect(asked).toEqual([]);
    expect(last()).toMatchObject({ query: 'in', phase: 'waiting' });

    vi.advanceTimersByTime(1);
    expect(asked.map(({ address, words }) => [address, words])).toEqual([
      ['a@x.co', 'in'],
      ['b@x.co', 'in'],
    ]);
    expect(last()).toMatchObject({ phase: 'asking', asking: ['a@x.co', 'b@x.co'] });
  });

  it('aborts the search a new keystroke supersedes, and hears nothing more from it', async () => {
    const { search, asked, pending, last, landed } = world();
    search.type('old');
    vi.advanceTimersByTime(1000);
    const report = pending.get('a@x.co')?.report;
    search.type('new');
    expect(asked.every(({ signal }) => signal.aborted)).toBe(true);

    report?.(matches('inbox', [1]));
    await landed('a@x.co');
    expect(last()).toEqual({ query: 'new', phase: 'waiting', asking: [], answers: [], failed: [] });
  });

  it('keeps a query it is already asking when only a space changed', () => {
    const { search, asked } = world();
    search.now('word');
    search.type('word ');
    expect(asked).toHaveLength(2);
    expect(asked.some(({ signal }) => signal.aborted)).toBe(false);
  });

  it('sends nothing for an empty box, a query that only says where, or a view’s own query', () => {
    const { search, asked, last } = world();
    for (const text of ['', '   ', 'in:archive', 'mailbox:a@x.co', 'in:inbox', 'is:starred']) {
      search.type(text);
      vi.advanceTimersByTime(5000);
      search.now(text);
      expect(last()).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it('skips the pause on Enter, and asks once', () => {
    const { search, asked } = world();
    search.type('word');
    search.now('word');
    expect(asked).toHaveLength(2);
    search.now('word');
    vi.advanceTimersByTime(5000);
    expect(asked).toHaveLength(2);
  });

  it('settles with each folder’s answer and one address’s failure, keeping the others', async () => {
    const { search, pending, last, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(matches('inbox', [1]));
    expect(last()?.answers).toHaveLength(1);
    await landed('a@x.co');
    expect(last()).toMatchObject({ phase: 'asking', asking: ['b@x.co'] });
    await landed('b@x.co', { ok: false, error: { kind: 'stalled' } });
    expect(last()).toMatchObject({
      phase: 'settled',
      asking: [],
      failed: [{ address: 'b@x.co', failure: { kind: 'stalled' } }],
    });
    expect(last()?.answers).toHaveLength(1);
  });

  it('asks only the failed address again on Retry', async () => {
    const { search, asked, last, landed } = world();
    search.now('word');
    await landed('a@x.co');
    await landed('b@x.co', { ok: false, error: { kind: 'stalled' } });
    search.retry();
    expect(asked.map(({ address }) => address)).toEqual(['a@x.co', 'b@x.co', 'b@x.co']);
    expect(last()).toMatchObject({ phase: 'asking', asking: ['b@x.co'], failed: [] });
    await landed('b@x.co');
    expect(last()).toMatchObject({ phase: 'settled', failed: [] });
  });

  it('stops on leaving the search', () => {
    const { search, asked, last } = world();
    search.now('word');
    search.stop();
    expect(asked.every(({ signal }) => signal.aborted)).toBe(true);
    expect(last()).toBeNull();
  });
});

describe('createServerSearch paging matches', () => {
  const page = (folder: FolderMatches['folder'], reachedAt: number, rest: readonly number[]) => ({
    ...matches(folder, [100]),
    reachedAt,
    rest,
  });

  it('reads the next page of the folder that stops soonest, without searching again', async () => {
    const { search, asked, pending, more, last, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('archive', 500, [90, 80]));
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    pending.get('b@x.co')?.report(matches('inbox', [1]));
    await landed('a@x.co');
    await landed('b@x.co');
    const searched = asked.length;

    await search.more();
    expect(more.map(({ previous }) => [previous.folder, previous.rest])).toEqual([['inbox', [70]]]);
    expect(asked).toHaveLength(searched);
    expect(last()?.answers.at(-1)).toMatchObject({
      address: 'a@x.co',
      matches: [{ folder: 'inbox', hits: [70], rest: [] }],
    });

    await search.more();
    expect(more.at(-1)?.previous).toMatchObject({ folder: 'archive', rest: [90, 80] });
  });

  it('hands back a page that failed, and it is no failed search: Retry does not start again', async () => {
    const { search, asked, pending, moreAnswer, last, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    await landed('a@x.co');
    await landed('b@x.co');
    const searched = asked.length;
    moreAnswer.current = Promise.resolve({ ok: false, error: { kind: 'stalled' } });

    expect(await search.more()).toMatchObject({
      mailbox: { address: 'a@x.co' },
      result: { ok: false, error: { kind: 'stalled' } },
    });

    expect(last()?.failed).toEqual([]);
    search.retry();
    expect(asked).toHaveLength(searched);
  });

  it('hands back a page that threw as one that failed', async () => {
    const { search, pending, moreAnswer, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    await landed('a@x.co');
    await landed('b@x.co');
    moreAnswer.current = Promise.reject(new Error('chunk went away'));

    expect(await search.more()).toMatchObject({
      result: { ok: false, error: { kind: 'error', detail: 'chunk went away' } },
    });
  });

  it('says a page landed, and says nothing when there was none to read', async () => {
    const { search, pending, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    await landed('a@x.co');
    expect(await search.more()).toBeNull();
    await landed('b@x.co');
    expect(await search.more()).toMatchObject({ result: { ok: true } });
    expect(await search.more()).toBeNull();
  });

  it('reads no older matches while the servers are still answering', async () => {
    const { search, pending, more, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    await landed('a@x.co');
    await search.more();
    expect(more).toEqual([]);
  });

  it('drops what a page read, and the matches it named, once a newer search has superseded it', async () => {
    const { search, pending, more, moreAnswer, last, landed } = world();
    search.now('word');
    pending.get('a@x.co')?.report(page('inbox', 900, [70]));
    await landed('a@x.co');
    await landed('b@x.co');
    const answer = Promise.withResolvers<Result<FolderMatches, MailConnectionFailure> | null>();
    moreAnswer.current = answer.promise;
    const reading = search.more();
    await vi.advanceTimersByTimeAsync(0);

    search.type('other');
    expect(more[0]?.signal.aborted).toBe(true);
    answer.resolve({ ok: true, value: matches('inbox', [70]) });
    await reading;
    expect(last()).toEqual({
      query: 'other',
      phase: 'waiting',
      asking: [],
      answers: [],
      failed: [],
    });
  });

  it('asks only the mailbox named, and nothing of an alias', () => {
    expect(planOf('word mailbox:b@x.co', mailboxes)?.mailboxes).toEqual([{ address: 'b@x.co' }]);
    expect(planOf('word mailbox:alias@x.co', mailboxes)).toBeNull();
  });
});

describe('askServers', () => {
  it('answers once every address has, with what each found or why it could not', async () => {
    const plan = planOf('word', mailboxes);
    if (plan === null) throw new Error('no plan');
    const { answers, failed } = await askServers({
      plan,
      searchOn: async ({ address }, { onMatches }) => {
        if (address === 'b@x.co') return { ok: false, error: { kind: 'stalled' } };
        onMatches(matches('inbox', [1]));
        return OK;
      },
    });
    expect(answers.map(({ address }) => address)).toEqual(['a@x.co']);
    expect(failed).toEqual([{ address: 'b@x.co', failure: { kind: 'stalled' } }]);
  });
});
