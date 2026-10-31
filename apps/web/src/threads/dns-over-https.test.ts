import { describe, expect, it, vi } from 'vitest';
import { createTxtLookup } from './dns-over-https';

const answer = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

/** A DoH server answering every request with `reply`, remembering what it was asked. */
const server = (reply: () => Response | Promise<Response>) => {
  const asked: URL[] = [];
  const fetchDoh = vi.fn(async (input: RequestInfo | URL) => {
    asked.push(new URL(input.toString()));
    return reply();
  }) as unknown as typeof fetch;
  return { fetchDoh, asked };
};

const NAME = 's1024._domainkey.yahoo.com';

describe('createTxtLookup', () => {
  it('asks Cloudflare for the name as JSON, without credentials or a referrer', async () => {
    const { fetchDoh, asked } = server(() => answer({ Status: 0, Answer: [] }));
    await createTxtLookup(fetchDoh)(NAME);
    expect(asked.map(url => `${url.origin}${url.pathname}?${url.searchParams}`)).toEqual([
      `https://cloudflare-dns.com/dns-query?name=${NAME}&type=TXT`,
    ]);
    expect(vi.mocked(fetchDoh).mock.calls[0]?.[1]).toMatchObject({
      headers: { accept: 'application/dns-json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
  });

  it('unquotes each record and joins the strings a long one is split into', async () => {
    const { fetchDoh } = server(() =>
      answer({
        Status: 0,
        Answer: [
          // A CNAME rides ahead of the TXT it leads to.
          { name: NAME, type: 5, data: 'k.example.com.' },
          {
            name: 'k.example.com',
            type: 16,
            data: '"k=rsa;  p=MIGfMA0" "JiDJOKU3AQAB; n=A \\"1024\\" bit key;"',
          },
          { name: 'k.example.com', type: 16, data: '"v=other"' },
        ],
      }),
    );
    expect(await createTxtLookup(fetchDoh)(NAME)).toEqual([
      'k=rsa;  p=MIGfMA0JiDJOKU3AQAB; n=A "1024" bit key;',
      'v=other',
    ]);
  });

  it('answers no records for a name that does not exist or holds no TXT', async () => {
    const missing = server(() => answer({ Status: 3 }));
    expect(await createTxtLookup(missing.fetchDoh)(NAME)).toEqual([]);
    const cname = server(() =>
      answer({ Status: 0, Answer: [{ name: NAME, type: 5, data: 'elsewhere.example.' }] }),
    );
    expect(await createTxtLookup(cname.fetchDoh)(NAME)).toEqual([]);
  });

  it.each([
    ['a server failure', () => answer({ Status: 2 })],
    ['an HTTP error', () => answer({}, { status: 503 })],
    ['an answer that is not DNS JSON', () => answer({ nope: true })],
    ['text that is not JSON', () => new Response('<html>')],
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ])('answers null for %s', async (_, reply) => {
    expect(await createTxtLookup(server(reply).fetchDoh)(NAME)).toBeNull();
  });

  it('asks once for a name looked up many times at once, and again after the cache expires', async () => {
    let clock = 0;
    const { fetchDoh, asked } = server(() =>
      answer({ Status: 0, Answer: [{ name: NAME, type: 16, data: '"p=KEY"' }] }),
    );
    const lookup = createTxtLookup(fetchDoh, () => clock);
    const together = await Promise.all(Array.from({ length: 50 }, () => lookup(NAME)));
    expect(new Set(together.map(records => records?.join()))).toEqual(new Set(['p=KEY']));
    expect(asked).toHaveLength(1);
    await lookup(NAME);
    expect(asked).toHaveLength(1);
    clock += 60 * 60 * 1000;
    await lookup(NAME);
    expect(asked).toHaveLength(2);
  });

  it('does not keep a failed lookup, so the next message tries again', async () => {
    let isDown = true;
    const { fetchDoh, asked } = server(() =>
      isDown
        ? answer({ Status: 2 })
        : answer({ Status: 0, Answer: [{ name: NAME, type: 16, data: '"p=KEY"' }] }),
    );
    const lookup = createTxtLookup(fetchDoh);
    expect(await lookup(NAME)).toBeNull();
    isDown = false;
    expect(await lookup(NAME)).toEqual(['p=KEY']);
    expect(asked).toHaveLength(2);
  });
});
