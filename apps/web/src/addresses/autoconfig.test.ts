/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { describeSource, domainOf, lookupMailServers, usernameFor } from './autoconfig';

const found = {
  imap: { host: 'imap.fastmail.com', port: 993 },
  smtp: { host: 'smtp.fastmail.com', port: 465 },
  username: 'address',
  source: 'ispdb',
  sourceDomain: 'messagingengine.com',
} as const;

describe('domainOf', () => {
  it('takes the part after the last @ when it has two labels', () => {
    expect(domainOf('jason@Fastmail.com')).toBe('fastmail.com');
    expect(domainOf('a@b@c.d')).toBe('c.d');
    expect(domainOf('jason@localhost')).toBeNull();
    expect(domainOf('jason')).toBeNull();
    expect(domainOf('jason@')).toBeNull();
  });
});

describe('usernameFor', () => {
  it('follows the placeholder the provider published', () => {
    expect(usernameFor('jason@x.test', 'address')).toBe('jason@x.test');
    expect(usernameFor('jason@x.test', 'localpart')).toBe('jason');
  });
});

describe('lookupMailServers', () => {
  const answering = (status: number, body?: unknown): typeof fetch =>
    (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), { status })) as typeof fetch;

  it('distinguishes nothing-published from the lookup failing', async () => {
    expect(await lookupMailServers('x.test', answering(200, found))).toEqual({
      status: 'found',
      config: found,
    });
    expect(await lookupMailServers('x.test', answering(404))).toEqual({ status: 'none' });
    expect(await lookupMailServers('x.test', answering(401))).toEqual({ status: 'unavailable' });
    expect(await lookupMailServers('x.test', answering(200, { junk: true }))).toEqual({
      status: 'unavailable',
    });
    const failing: typeof fetch = async () => {
      throw new TypeError('offline');
    };
    expect(await lookupMailServers('x.test', failing)).toEqual({ status: 'unavailable' });
  });
});

describe('describeSource', () => {
  it('names the MX domain when that is what answered', () => {
    expect(describeSource(found)).toBe('the Thunderbird ISPDB entry for messagingengine.com');
    expect(describeSource({ ...found, source: 'provider', sourceDomain: 'fastmail.com' })).toBe(
      "fastmail.com's published configuration",
    );
  });
});
