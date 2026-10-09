import { describe, expect, it } from 'vitest';
import {
  addresseesOf,
  inboxesOf,
  isArchived,
  isTrashed,
  type Message,
  toParagraphs,
} from './thread';

describe('isArchived', () => {
  it('is a thread with archive mail and nothing left in the inbox', () => {
    expect(isArchived({ folders: ['archive'] })).toBe(true);
    expect(isArchived({ folders: ['sent', 'archive'] })).toBe(true);
    // A reply that landed after the archive brings the conversation back, as in Gmail.
    expect(isArchived({ folders: ['inbox', 'archive'] })).toBe(false);
    expect(isArchived({ folders: ['inbox', 'sent'] })).toBe(false);
  });
});

describe('isTrashed', () => {
  it('is a thread whose every message sits in the bin', () => {
    expect(isTrashed({ folders: ['trash'] })).toBe(true);
    // Half of it deleted is not deleted: the rest is still live mail.
    expect(isTrashed({ folders: ['inbox', 'trash'] })).toBe(false);
    expect(isTrashed({ folders: ['sent', 'trash'] })).toBe(false);
    expect(isTrashed({ folders: [] })).toBe(false);
  });
});

const at = (account: string, folder: 'inbox' | 'sent' | 'archive', uid = 1) => ({
  account,
  folder,
  uidValidity: 1,
  uid,
});

const message = (overrides: Partial<Message>): Message => ({
  id: 'm',
  fromName: 'Dana',
  fromAddress: 'dana@ferndale.example',
  toAddress: 'jason@jyu.example',
  at: 1,
  body: [],
  ...overrides,
});

describe('inboxesOf', () => {
  it('names each account a message arrived at once, wherever it has been filed since', () => {
    const copies = message({
      locations: [
        at('jason@jyu.example', 'inbox', 1),
        at('jason@jyu.example', 'inbox', 2),
        at('hello@stillwater.example', 'archive'),
      ],
    });
    expect(inboxesOf(copies)).toEqual(['jason@jyu.example', 'hello@stillwater.example']);
  });

  it('leaves out your own Sent copy, so mail you sent landed nowhere unless you copied yourself', () => {
    expect(inboxesOf(message({ locations: [at('jason@jyu.example', 'sent')] }))).toEqual([]);
    expect(
      inboxesOf(
        message({
          locations: [at('jason@jyu.example', 'sent'), at('hello@stillwater.example', 'inbox')],
        }),
      ),
    ).toEqual(['hello@stillwater.example']);
    expect(inboxesOf(message({}))).toEqual([]);
  });

  it('never counts the sending account, so a deleted Sent copy in Trash is not an arrival', () => {
    const deleted = message({
      fromAddress: 'Jason@JYU.example',
      locations: [{ account: 'jason@jyu.example', folder: 'trash', uidValidity: 1, uid: 1 }],
    });
    expect(inboxesOf(deleted)).toEqual([]);
  });
});

describe('addresseesOf', () => {
  const owned = ['jason@jyu.example', 'hello@stillwater.example'];

  it('reads To then Cc in header order, every address you own as one "me"', () => {
    const addressed = message({
      to: [{ name: 'Dad', address: 'dad@jyu.example' }, { address: 'Jason@JYU.example' }],
      cc: [{ address: 'hello@stillwater.example' }, { address: 'mei@example.com' }],
    });
    expect(addresseesOf(addressed, owned)).toEqual([
      { name: 'Dad', address: 'dad@jyu.example' },
      'me',
      { address: 'mei@example.com' },
    ]);
  });

  it('names an address once when To and Cc both carry it, and keeps two people of one name', () => {
    const addressed = message({
      to: [
        { name: 'Sam', address: 'sam@one.example' },
        { name: 'Sam', address: 'sam@two.example' },
      ],
      cc: [{ name: 'Sam', address: 'SAM@one.example' }],
    });
    expect(addresseesOf(addressed, owned)).toEqual([
      { name: 'Sam', address: 'sam@one.example' },
      { name: 'Sam', address: 'sam@two.example' },
    ]);
  });

  it('is empty for a Bcc that names nobody, and for a draft with no envelope', () => {
    expect(addresseesOf(message({ to: [], cc: [] }), owned)).toEqual([]);
    expect(addresseesOf(message({}), owned)).toEqual([]);
  });
});

describe('toParagraphs', () => {
  it('splits on blank lines and keeps single line breaks inside a paragraph', () => {
    expect(toParagraphs('a\r\nb\r\n\r\n\r\nc\n')).toEqual(['a\nb', 'c']);
  });
});
