import { describe, expect, it } from 'vitest';
import {
  hasCriteria,
  isThreadInScope,
  parseQuery,
  resolveScope,
  type SearchScope,
  viewOfFolders,
} from './query.ts';
import type { Message, ThreadState } from './thread.ts';

const EMPTY = {
  terms: [],
  in: [],
  mailboxes: [],
  isUnread: false,
  isStarred: false,
  before: [],
  after: [],
};
const any = (text: string) => ({ field: 'any', text });

describe('parseQuery', () => {
  it.each([
    ['', {}],
    ['   ', {}],
    ['invoice', { terms: [any('invoice')] }],
    ['invoice paid', { terms: [any('invoice'), any('paid')] }],
    ['"exact phrase"', { terms: [any('exact phrase')] }],
    ['a "b c" d', { terms: [any('a'), any('b c'), any('d')] }],
    ['from:stripe', { terms: [{ field: 'from', text: 'stripe' }] }],
    ['to:me@x.co', { terms: [{ field: 'to', text: 'me@x.co' }] }],
    ['subject:"new invoice"', { terms: [{ field: 'subject', text: 'new invoice' }] }],
    [
      'from:"Ann Lee" to:bo',
      {
        terms: [
          { field: 'from', text: 'Ann Lee' },
          { field: 'to', text: 'bo' },
        ],
      },
    ],
    ['in:inbox', { in: ['inbox'] }],
    ['in:sent in:archive', { in: ['sent', 'archive'] }],
    ['in:trash in:drafts in:anywhere', { in: ['trash', 'drafts', 'anywhere'] }],
    ['mailbox:you@example.com', { mailboxes: ['you@example.com'] }],
    ['mailbox:a@x.co mailbox:b@y.co', { mailboxes: ['a@x.co', 'b@y.co'] }],
    ['is:unread', { isUnread: true }],
    ['is:starred', { isStarred: true }],
    ['before:2026/11/01', { before: [{ year: 2026, month: 11, day: 1 }] }],
    ['after:2026-02-28', { after: [{ year: 2026, month: 2, day: 28 }] }],
    ['after:2024/02/29', { after: [{ year: 2024, month: 2, day: 29 }] }],
    [
      'FROM:Stripe IN:Archive Is:UNREAD',
      {
        terms: [{ field: 'from', text: 'Stripe' }],
        in: ['archive'],
        isUnread: true,
      },
    ],
  ])('reads %j', (text, expected) => {
    expect(parseQuery(text)).toEqual({ ...EMPTY, ...expected });
  });

  it.each([
    ['foo:bar', 'foo:bar'],
    ['in:nope', 'in:nope'],
    ['is:read', 'is:read'],
    ['is:', 'is:'],
    ['from:', 'from:'],
    ['before:soon', 'before:soon'],
    ['before:2026/13/01', 'before:2026/13/01'],
    ['before:2026/02/30', 'before:2026/02/30'],
    ['after:2026/01-05', 'after:2026/01-05'],
    ['after:26/01/05', 'after:26/01/05'],
    ['mailbox:archive', 'mailbox:archive'],
    ['mailbox:a@b@c', 'mailbox:a@b@c'],
    ['https://yozz.app/m/unified', 'https://yozz.app/m/unified'],
    ['12:30', '12:30'],
    [':colon', ':colon'],
    ['constructor:x', 'constructor:x'],
    ['__proto__:x', '__proto__:x'],
    ['foo"bar', 'foo"bar'],
  ])('reads %j as plain text', (text, plain) => {
    expect(parseQuery(text)).toEqual({ ...EMPTY, terms: [any(plain)] });
  });

  it('keeps a quoted unknown as one term, an operator inside a phrase as text, and drops an empty phrase', () => {
    expect(parseQuery('foo:"bar baz"').terms).toEqual([any('foo:bar baz')]);
    expect(parseQuery('"from:stripe in:trash"')).toEqual({
      ...EMPTY,
      terms: [any('from:stripe in:trash')],
    });
    expect(parseQuery('from:""').terms).toEqual([any('from:')]);
    expect(parseQuery('"" "  " word').terms).toEqual([any('word')]);
  });

  it('runs an unclosed quote to the end, as it never fails', () => {
    expect(parseQuery('"a b').terms).toEqual([any('a b')]);
    expect(parseQuery('from:"a b').terms).toEqual([{ field: 'from', text: 'a b' }]);
  });
});

describe('hasCriteria', () => {
  it('is something to look for, not somewhere to look', () => {
    expect(hasCriteria(parseQuery(''))).toBe(false);
    expect(hasCriteria(parseQuery('in:archive mailbox:a@x.co'))).toBe(false);
    for (const text of [
      'x',
      'from:x',
      'is:unread',
      'is:starred',
      'before:2026/01/01',
      'after:2026/01/01',
    ]) {
      expect(hasCriteria(parseQuery(text))).toBe(true);
    }
  });
});

describe('resolveScope', () => {
  const inbound = [{ address: 'Me@x.co' }, { address: 'us@y.co' }];
  const scopeOf = (text: string): SearchScope<{ readonly address: string }> => {
    const scope = resolveScope(parseQuery(text), inbound);
    if (!scope.ok) throw new Error(scope.error.message);
    return scope.value;
  };

  it('resolves an empty query to every folder but Trash, of every mailbox', () => {
    const everythingButTrash = ['inbox', 'sent', 'archive', 'drafts'];
    expect(scopeOf('')).toEqual({
      folders: everythingButTrash,
      mailboxes: inbound,
      isEveryMailbox: true,
    });
    expect(scopeOf('   ').folders).toEqual(everythingButTrash);
  });

  it('covers every folder but Trash for bare words with no in:, Archive included', () => {
    for (const text of [
      'invoice',
      'two words',
      '"a phrase"',
      'from:x',
      'is:unread',
      'mailbox:us@y.co',
    ]) {
      expect(scopeOf(text).folders).toEqual(['inbox', 'sent', 'archive', 'drafts']);
    }
  });

  it('reaches Trash and Junk only through their own in: or in:anywhere', () => {
    expect(scopeOf('').folders).toEqual(['inbox', 'sent', 'archive', 'drafts']);
    expect(scopeOf('invoice in:trash').folders).toEqual(['trash']);
    expect(scopeOf('invoice in:junk').folders).toEqual(['junk']);
    expect(scopeOf('in:anywhere').folders).toEqual([
      'inbox',
      'sent',
      'archive',
      'trash',
      'junk',
      'drafts',
    ]);
    expect(scopeOf('invoice in:inbox').folders).toEqual(['inbox']);
  });

  it('takes a repeated in: as a union, in the folders’ order', () => {
    expect(scopeOf('in:archive in:inbox').folders).toEqual(['inbox', 'archive']);
    expect(scopeOf('in:drafts').folders).toEqual(['drafts']);
  });

  it('matches mailbox: case-insensitively, a repeat as a union, naming them as connected', () => {
    expect(scopeOf('mailbox:me@X.CO').mailboxes).toEqual([{ address: 'Me@x.co' }]);
    expect(scopeOf('mailbox:me@x.co mailbox:US@y.co').mailboxes).toEqual(inbound);
    expect(scopeOf('mailbox:me@x.co').isEveryMailbox).toBe(false);
  });

  it('refuses an address with no mailbox and points to to:, rather than answering nothing', () => {
    expect(resolveScope(parseQuery('mailbox:invoice@fishball.ltd x'), inbound)).toEqual({
      ok: false,
      error: {
        message: expect.stringMatching(
          /^invoice@fishball\.ltd has no mailbox.*To find mail sent to it, use to:invoice@fishball\.ltd$/u,
        ),
      },
    });
    expect(resolveScope(parseQuery('mailbox:me@x.co mailbox:no@x.co'), inbound).ok).toBe(false);
  });
});

describe('isThreadInScope', () => {
  const copy = (
    mailbox: string,
    folder: 'inbox' | 'sent' | 'archive' | 'trash',
    uidValidity = 1,
  ) => ({
    mailbox,
    folder,
    uidValidity,
    uid: 1,
  });
  const threadOf = (message: Partial<Message>): ThreadState => ({
    id: 't',
    mailboxes: [],
    subject: 's',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    folders: [],
    foldersByMailbox: {},
    messages: [
      { id: 'm', fromName: 'x', fromAddress: 'x@x.co', toAddress: '', at: 0, body: [], ...message },
    ],
  });
  const inScope = (text: string, message: Partial<Message>) => {
    const scope = resolveScope(parseQuery(text), [{ address: 'me@x.co' }, { address: 'us@y.co' }]);
    if (!scope.ok) throw new Error(scope.error.message);
    const copies = (message.locations ?? []).filter(({ uidValidity }) => uidValidity !== 0);
    const held = [...new Set((message.locations ?? []).map(({ folder }) => folder))];
    return isThreadInScope(scope.value)({
      ...threadOf(message),
      folders: message.isDraft === true ? ['drafts'] : held,
      foldersByMailbox: Object.fromEntries(
        copies.map(({ mailbox }) => [
          mailbox,
          copies.filter(copy => copy.mailbox === mailbox).map(({ folder }) => folder),
        ]),
      ),
    });
  };

  it('asks of a copy’s folder and whose login holds it', () => {
    const locations = [copy('us@y.co', 'archive')];
    expect(inScope('in:archive', { locations })).toBe(true);
    expect(inScope('in:inbox', { locations })).toBe(false);
    expect(inScope('mailbox:us@y.co', { locations })).toBe(true);
    expect(inScope('mailbox:me@x.co', { locations })).toBe(false);
    expect(inScope('mailbox:us@y.co', { locations: [copy('us@y.co', 'trash')] })).toBe(false);
  });

  it('holds a send-only address’s vault copy under no mailbox, but in every-mailbox scopes', () => {
    const locations = [copy('alias@x.co', 'sent', 0)];
    expect(inScope('in:sent', { locations })).toBe(true);
    expect(inScope('in:sent mailbox:me@x.co', { locations })).toBe(false);
  });

  it('takes Archive to mean filed away: a conversation with inbox mail too is in the inbox', () => {
    const both = [copy('me@x.co', 'archive'), copy('me@x.co', 'inbox')];
    expect(inScope('in:archive', { locations: both })).toBe(false);
    expect(inScope('in:inbox', { locations: both })).toBe(true);
    expect(inScope('in:anywhere', { locations: both })).toBe(true);
  });

  it('finds a draft by the address it would go from', () => {
    const draft = { isDraft: true, locations: [], fromAddress: 'ME@x.co' };
    expect(inScope('in:drafts', draft)).toBe(true);
    expect(inScope('mailbox:me@x.co', draft)).toBe(true);
    expect(inScope('mailbox:us@y.co', draft)).toBe(false);
    expect(inScope('in:inbox', draft)).toBe(false);
  });
});

describe('viewOfFolders', () => {
  it('opens a row in the single folder’s view, and unified otherwise', () => {
    expect(viewOfFolders(['inbox'])).toBe('unified');
    expect(viewOfFolders(['archive'])).toBe('archive');
    expect(viewOfFolders(['drafts'])).toBe('drafts');
    expect(viewOfFolders(['inbox', 'sent'])).toBe('unified');
  });
});
