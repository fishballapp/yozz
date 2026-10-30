import { describe, expect, it } from 'vitest';
import { RETURN_SYNC_FRESH_MS, staleAccounts } from './sync-staleness.ts';

const NOW = 10_000_000;
const accounts = [{ address: 'a@x.test' }, { address: 'b@x.test' }, { address: 'c@x.test' }];

describe('staleAccounts', () => {
  it('syncs an address that has never synced', () => {
    expect(staleAccounts(accounts, new Map(), NOW)).toEqual(accounts);
  });

  it('skips an address whose last sync started less than two minutes ago', () => {
    const started = new Map([['a@x.test', NOW - RETURN_SYNC_FRESH_MS + 1]]);
    expect(staleAccounts(accounts, started, NOW)).toEqual([accounts[1], accounts[2]]);
  });

  it('syncs an address whose last sync started exactly two minutes ago', () => {
    const started = new Map([['a@x.test', NOW - RETURN_SYNC_FRESH_MS]]);
    expect(staleAccounts(accounts, started, NOW)).toEqual(accounts);
  });

  it('syncs an address whose last sync started long ago, and skips a fresh one in the same list', () => {
    const started = new Map([
      ['a@x.test', NOW - 60 * 60 * 1000],
      ['b@x.test', NOW - 1000],
    ]);
    expect(staleAccounts(accounts, started, NOW)).toEqual([accounts[0], accounts[2]]);
  });
});
