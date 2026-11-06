import type {
  ImapResult,
  ImapSelected,
  UidSearchCriteria,
  UidSearchCriterion,
} from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import type { MailClient, MailTask, RunTask } from '../connection.ts';
import { stubImapClient } from '../testing/fake-imap-client.ts';
import { memoryMailCache } from '../testing/memory-mail-cache.ts';
import { parseQuery } from './query.ts';
import { readMoreMatches, searchMailbox } from './search.ts';

const SELECTED: ImapSelected = {
  name: 'INBOX',
  exists: 1,
  uidValidity: 1,
  uidNext: 2,
  flags: [],
  permanentFlags: [],
  readOnly: false,
};

/** The keys of a command, in the order they were sent. */
const keysOf = (criteria: UidSearchCriteria) => [criteria].flat().map(({ key }) => key);

/** Runs a task at once on a client that records each command and may be told to do something first. */
const world = (
  onSearch: (commands: readonly string[]) => void = () => {},
  answer: (criteria: readonly UidSearchCriterion[]) => readonly number[] = () => [],
) => {
  const commands: string[] = [];
  let selected: string | null = null;
  const client = {
    ...stubImapClient(),
    ensureSelected: async (name: string): Promise<ImapResult<ImapSelected>> => {
      // As the runners do: no command when it is already the selected folder.
      if (selected !== name) commands.push(`SELECT ${name}`);
      selected = name;
      return { ok: true, value: SELECTED };
    },
    uidSearch: async (criteria: UidSearchCriteria): Promise<ImapResult<readonly number[]>> => {
      commands.push(`SEARCH ${keysOf(criteria).join(' ')}`);
      onSearch(commands);
      return { ok: true, value: answer([criteria].flat()) };
    },
  } as unknown as MailClient;
  const run: RunTask = <T>(task: MailTask<T>) => task.run(client);
  return { commands, run };
};

const cacheWithFolders = async () => {
  const cache = memoryMailCache();
  for (const folder of ['inbox', 'sent', 'archive'] as const) {
    await cache
      .folder(folder)
      .putSync({ name: folder, uidValidity: 1, lastUid: 0, complete: true });
  }
  return cache;
};

describe('searchMailbox', () => {
  it('asks each field of each folder when nothing stops it', async () => {
    const { commands, run } = world();
    const result = await searchMailbox({
      run,
      cache: await cacheWithFolders(),
      folders: ['inbox'],
      query: parseQuery('needle'),
    });
    expect(result.ok).toBe(true);
    expect(commands.filter(command => command.startsWith('SEARCH'))).toHaveLength(6);
  });

  it('stops between commands once aborted, and answers cancelled', async () => {
    const controller = new AbortController();
    const { commands, run } = world(sent => {
      if (sent.length === 3) controller.abort();
    });
    const result = await searchMailbox({
      run,
      cache: await cacheWithFolders(),
      folders: ['inbox', 'sent', 'archive'],
      query: parseQuery('needle'),
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    // The one that aborted it was on the wire; none followed, in this folder or the next.
    expect(commands).toEqual(['SELECT inbox', 'SEARCH SUBJECT', 'SEARCH FROM']);
  });

  it('runs each command as a task of its own, selecting once a folder', async () => {
    const { commands, run } = world();
    let tasks = 0;
    const result = await searchMailbox({
      run: task => {
        tasks += 1;
        return run(task);
      },
      cache: await cacheWithFolders(),
      folders: ['inbox', 'sent'],
      query: parseQuery('needle'),
    });
    expect(result.ok).toBe(true);
    // Six fields in the inbox, and Bcc as well on Sent.
    expect(tasks).toBe(13);
    expect(commands.filter(command => command.startsWith('SELECT'))).toEqual([
      'SELECT inbox',
      'SELECT sent',
    ]);
  });

  it('refuses a folder renumbered mid-search, without another command on it', async () => {
    const { commands, run } = world();
    let tasks = 0;
    const result = await searchMailbox({
      run: task => {
        tasks += 1;
        // The second command's selection answers under a new UIDVALIDITY.
        if (tasks < 2) return run(task);
        return task.run({
          ...stubImapClient(),
          ensureSelected: async () => ({ ok: true, value: { ...SELECTED, uidValidity: 2 } }),
          uidSearch: async () => {
            commands.push('SEARCH after renumbering');
            return { ok: true, value: [] };
          },
        } as unknown as MailClient);
      },
      cache: await cacheWithFolders(),
      folders: ['inbox'],
      query: parseQuery('needle'),
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'error', detail: 'a folder was renumbered; sync and search again' },
    });
    expect(commands).not.toContain('SEARCH after renumbering');
  });

  it('reads the newest matches and names the rest, then reads on without searching again', async () => {
    const uids = Array.from({ length: 250 }, (_, index) => index + 1);
    const summary = (uid: number) => ({
      seq: uid,
      uid,
      flags: [],
      internalDate: `0${(uid % 9) + 1}-Jan-2020 00:00:00 +0000`,
      size: 1,
      envelope: null,
      references: [],
      gmailThreadId: null,
      attachmentNames: [],
    });
    const commands: string[] = [];
    const client = {
      ...stubImapClient(),
      ensureSelected: async () => ({ ok: true, value: SELECTED }),
      uidSearch: async (criteria: UidSearchCriteria) => {
        commands.push(`SEARCH ${keysOf(criteria).join(' ')}`);
        return { ok: true, value: keysOf(criteria).includes('FROM') ? uids : [] };
      },
      fetchSummaries: async (set: string) => {
        commands.push('FETCH');
        const [from, to] = set.split(':').map(Number);
        return {
          ok: true,
          value: uids.filter(uid => uid >= (from ?? 0) && uid <= (to ?? from ?? 0)).map(summary),
        };
      },
    } as unknown as MailClient;
    const run: RunTask = <T>(task: MailTask<T>) => task.run(client);
    const cache = await cacheWithFolders();

    const first = await searchMailbox({
      run,
      cache,
      folders: ['inbox'],
      query: parseQuery('from:needle'),
    });
    if (!first.ok) throw new Error('The search failed');
    const [inbox] = first.value;
    if (inbox === undefined) throw new Error('No answer');
    expect(inbox.hits).toHaveLength(200);
    expect(inbox.hits[0]).toBe(250);
    expect(inbox.rest).toEqual(uids.slice(0, 50).toReversed());
    expect(inbox.reachedAt).not.toBeNull();

    commands.length = 0;
    const second = await readMoreMatches({ run, cache, previous: inbox });
    if (!second.ok) throw new Error('The page failed');
    expect(second.value.hits).toEqual(inbox.rest);
    expect(second.value.rest).toEqual([]);
    expect(second.value.reachedAt).toBeNull();
    expect(second.value.summaries).toHaveLength(50);
    // The server named them already: only the read, and no UID SEARCH.
    expect(commands).toEqual(['FETCH']);
  });

  describe('how far a page reached, when its lowest hit cannot say', () => {
    const uids = Array.from({ length: 250 }, (_, index) => index + 1);
    const JANUARY = '05-Jan-2020 00:00:00 +0000';
    const pageWith = async (summaryOf: (uid: number) => { internalDate: string } | null) => {
      const client = {
        ...stubImapClient(),
        ensureSelected: async () => ({ ok: true, value: SELECTED }),
        uidSearch: async (criteria: UidSearchCriteria) => ({
          ok: true,
          value: keysOf(criteria).includes('FROM') ? uids : [],
        }),
        fetchSummaries: async () => ({
          ok: true,
          value: uids.flatMap(uid => {
            const known = summaryOf(uid);
            return known === null
              ? []
              : [
                  {
                    seq: uid,
                    uid,
                    flags: [],
                    size: 1,
                    envelope: null,
                    references: [],
                    gmailThreadId: null,
                    attachmentNames: [],
                    ...known,
                  },
                ];
          }),
        }),
      } as unknown as MailClient;
      const run: RunTask = <T>(task: MailTask<T>) => task.run(client);
      const found = await searchMailbox({
        run,
        cache: await cacheWithFolders(),
        folders: ['inbox'],
        query: parseQuery('from:needle'),
      });
      if (!found.ok) throw new Error('The search failed');
      return found.value[0]?.reachedAt;
    };
    // The newest 200 of 250: the lowest hit is uid 51.
    const asDate = Date.UTC(2020, 0, 5);

    it('takes the next one up when it was expunged before the read', async () => {
      expect(await pageWith(uid => (uid === 51 ? null : { internalDate: JANUARY }))).toBe(asDate);
    });

    it('takes the next one up when its date does not parse', async () => {
      const summaryOf = (uid: number) => ({ internalDate: uid === 51 ? 'not a date' : JANUARY });
      expect(await pageWith(summaryOf)).toBe(asDate);
    });

    it('prefers the lowest hit that can say over a newer one', async () => {
      const summaryOf = (uid: number) => ({
        internalDate: uid === 52 ? JANUARY : '09-Mar-2024 00:00:00 +0000',
      });
      expect(await pageWith(uid => (uid === 51 ? null : summaryOf(uid)))).toBe(asDate);
    });

    it('reaches nowhere when every hit on the page is gone', async () => {
      expect(await pageWith(() => null)).toBeNull();
    });
  });

  it('stops reading on when aborted', async () => {
    const { commands, run } = world();
    const controller = new AbortController();
    controller.abort();
    const result = await readMoreMatches({
      run,
      cache: await cacheWithFolders(),
      previous: {
        folder: 'inbox',
        folderName: 'inbox',
        uidValidity: 1,
        hits: [9],
        summaries: [],
        rest: [1],
        reachedAt: 1,
      },
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(commands).toEqual([]);
  });

  it('sends nothing when aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { commands, run } = world();
    const result = await searchMailbox({
      run,
      cache: await cacheWithFolders(),
      folders: ['inbox'],
      query: parseQuery('needle'),
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, error: { kind: 'cancelled' } });
    expect(commands).toEqual([]);
  });

  it('hands over each folder as it answers', async () => {
    const { run } = world();
    const heard: string[] = [];
    await searchMailbox({
      run,
      cache: await cacheWithFolders(),
      folders: ['inbox', 'sent'],
      query: parseQuery('needle'),
      onMatches: ({ folder }) => heard.push(folder),
    });
    expect(heard).toEqual(['inbox', 'sent']);
  });

  describe('how many commands a query costs a folder', () => {
    const searched = async (query: string, folders: readonly ('inbox' | 'sent')[] = ['inbox']) => {
      // Every command finds uid 1, so none ends the folder early.
      const { commands, run } = world(undefined, () => [1]);
      await searchMailbox({
        run,
        cache: await cacheWithFolders(),
        folders,
        query: parseQuery(query),
      });
      return commands.filter(command => command.startsWith('SEARCH')).map(c => c.slice(7));
    };

    it('is one for flags, dates and a one-key term together', async () => {
      expect(await searched('is:unread from:stripe after:2026/01/01')).toEqual([
        'UNSEEN SINCE FROM',
      ]);
    });

    it('is one for flags and dates alone', async () => {
      expect(await searched('is:unread is:starred before:2026/01/01')).toEqual([
        'UNSEEN FLAGGED BEFORE',
      ]);
    });

    it('carries the flag on each field of a bare word, and costs no command of its own', async () => {
      const inbox = await searched('is:unread invoice');
      expect(inbox).toHaveLength(6);
      expect(inbox.every(keys => keys.startsWith('UNSEEN '))).toBe(true);
      expect(await searched('is:unread invoice', ['sent'])).toHaveLength(7);
    });

    it('puts the flag on the term with the fewest commands, and no other', async () => {
      expect(await searched('invoice from:stripe is:starred')).toEqual([
        'FLAGGED FROM',
        'SUBJECT',
        'FROM',
        'TO',
        'CC',
        'HEADER',
        'TEXT',
      ]);
    });

    it('is the commands of its terms and nothing for the words that are plain', async () => {
      expect(await searched('invoice')).toHaveLength(6);
    });

    it('keeps the flag in a command of its own when a cached attachment name widens the only term', async () => {
      const cache = await cacheWithFolders();
      await cache.folder('inbox').putSummaries([
        {
          seq: 1,
          uid: 7,
          flags: [],
          internalDate: '01-Jan-2026 00:00:00 +0000',
          size: 1,
          envelope: null,
          references: [],
          gmailThreadId: null,
          attachmentNames: ['invoice.pdf'],
        },
      ]);
      const { commands, run } = world(undefined, () => [1]);
      await searchMailbox({
        run,
        cache,
        folders: ['inbox'],
        query: parseQuery('is:unread invoice'),
      });
      // The name never met the server, so the flag has to be asked of it apart from the term.
      expect(commands.filter(command => command.startsWith('SEARCH'))).toEqual([
        'SEARCH UNSEEN',
        'SEARCH SUBJECT',
        'SEARCH FROM',
        'SEARCH TO',
        'SEARCH CC',
        'SEARCH HEADER',
        'SEARCH TEXT',
      ]);
    });

    it('asks a term only the server answers before an equal one a cached name widens', async () => {
      const cache = await cacheWithFolders();
      await cache.folder('inbox').putSummaries([
        {
          seq: 1,
          uid: 7,
          flags: [],
          internalDate: '01-Jan-2026 00:00:00 +0000',
          size: 1,
          envelope: null,
          references: [],
          gmailThreadId: null,
          attachmentNames: ['invoice.pdf'],
        },
      ]);
      // Nothing is unread and urgent, so the search ends without asking about the invoice.
      const { commands, run } = world(undefined, () => []);
      await searchMailbox({
        run,
        cache,
        folders: ['inbox'],
        query: parseQuery('invoice urgent is:unread'),
      });
      const searches = commands.filter(command => command.startsWith('SEARCH'));
      expect(searches).toHaveLength(6);
      expect(searches.every(command => command.startsWith('SEARCH UNSEEN '))).toBe(true);
    });

    it('stops at the first empty answer, and asks nothing of the other terms', async () => {
      const { commands, run } = world();
      await searchMailbox({
        run,
        cache: await cacheWithFolders(),
        folders: ['inbox'],
        query: parseQuery('is:unread from:stripe invoice'),
      });
      expect(commands.filter(command => command.startsWith('SEARCH'))).toEqual([
        'SEARCH UNSEEN FROM',
      ]);
    });
  });

  describe('what folded commands find', () => {
    type Mail = {
      readonly uid: number;
      readonly isUnread: boolean;
      readonly isStarred: boolean;
      readonly from: string;
      readonly subject: string;
    };
    const MAIL: readonly Mail[] = [
      { uid: 1, isUnread: true, isStarred: false, from: 'stripe', subject: 'invoice' },
      { uid: 2, isUnread: false, isStarred: false, from: 'stripe', subject: 'invoice' },
      { uid: 3, isUnread: true, isStarred: true, from: 'ann', subject: 'invoice' },
      { uid: 4, isUnread: true, isStarred: true, from: 'stripe', subject: 'lunch' },
    ];
    /** A server that meets every key of a command, as RFC 9051 has it. */
    const hitsOf = async (query: string) => {
      const meeting = (criterion: UidSearchCriterion, mail: Mail) => {
        if (criterion.key === 'UNSEEN') return mail.isUnread;
        if (criterion.key === 'FLAGGED') return mail.isStarred;
        if (criterion.key === 'FROM') return mail.from === criterion.value;
        if (criterion.key === 'SUBJECT') return mail.subject === criterion.value;
        return false;
      };
      const { run } = world(undefined, criteria =>
        MAIL.filter(mail => criteria.every(criterion => meeting(criterion, mail))).map(
          ({ uid }) => uid,
        ),
      );
      const result = await searchMailbox({
        run,
        cache: await cacheWithFolders(),
        folders: ['inbox'],
        query: parseQuery(query),
      });
      if (!result.ok) throw new Error('The search failed');
      return result.value[0]?.hits;
    };

    it('is what the flag and the sender met apart', async () => {
      expect(await hitsOf('is:unread from:stripe')).toEqual([4, 1]);
      expect(await hitsOf('is:unread is:starred from:stripe')).toEqual([4]);
    });

    it('is what the flag and a word met apart, by uid', async () => {
      expect(await hitsOf('is:unread invoice')).toEqual([3, 1]);
    });

    it('is what the flag met apart with two terms, one of them carrying it', async () => {
      expect(await hitsOf('is:unread from:stripe invoice')).toEqual([1]);
    });
  });
});
