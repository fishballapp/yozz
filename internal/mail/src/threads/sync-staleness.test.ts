import { describe, expect, it } from 'vitest';
import { RETURN_SYNC_FRESH_MS, staleMailboxes } from './sync-staleness.ts';

const NOW = 10_000_000;
const mailboxes = [{ address: 'a@x.test' }, { address: 'b@x.test' }, { address: 'c@x.test' }];

describe('staleMailboxes', () => {
  it('syncs an address that has never synced', () => {
    expect(staleMailboxes(mailboxes, new Map(), NOW)).toEqual(mailboxes);
  });

  it('skips an address whose last sync started less than two minutes ago', () => {
    const started = new Map([['a@x.test', NOW - RETURN_SYNC_FRESH_MS + 1]]);
    expect(staleMailboxes(mailboxes, started, NOW)).toEqual([mailboxes[1], mailboxes[2]]);
  });

  it('syncs an address whose last sync started exactly two minutes ago', () => {
    const started = new Map([['a@x.test', NOW - RETURN_SYNC_FRESH_MS]]);
    expect(staleMailboxes(mailboxes, started, NOW)).toEqual(mailboxes);
  });

  it('syncs an address whose last sync started long ago, and skips a fresh one in the same list', () => {
    const started = new Map([
      ['a@x.test', NOW - 60 * 60 * 1000],
      ['b@x.test', NOW - 1000],
    ]);
    expect(staleMailboxes(mailboxes, started, NOW)).toEqual([mailboxes[0], mailboxes[2]]);
  });
});
