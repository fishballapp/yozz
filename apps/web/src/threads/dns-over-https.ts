import type { TxtLookup } from '@yozz.app/mail/threads/dkim';
import { z } from 'zod';

/**
 * TXT lookups for DKIM keys, straight from the browser to Cloudflare's DNS-over-HTTPS: YOZZ's own
 * servers never see which domains the mail is from. Answer format: docs/knowledge/dkim.md.
 */

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const TXT = 16;
const NXDOMAIN = 3;
const TIMEOUT_MS = 8000;
/** Prefetch checks many messages from the same sender; a key rotated within this stays old for a session at most this long. */
const CACHE_MS = 10 * 60 * 1000;

const answerSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** `"k=rsa; p=MIGf" "JiDJ…"` → one record: each quoted string unescaped, then joined with nothing between. */
const recordOf = (data: string): string =>
  Array.from(data.matchAll(/"((?:[^"\\]|\\.)*)"/g), ([, text = '']) =>
    text.replace(/\\(\d{3}|.)/g, (_, escaped: string) =>
      escaped.length === 3 ? String.fromCharCode(Number(escaped)) : escaped,
    ),
  ).join('');

const queryTxt = async (
  fetchDoh: typeof fetch,
  name: string,
): Promise<readonly string[] | null> => {
  try {
    const url = new URL(DOH_URL);
    url.searchParams.set('name', name);
    url.searchParams.set('type', 'TXT');
    const res = await fetchDoh(url, {
      headers: { accept: 'application/dns-json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const answer = answerSchema.parse(await res.json());
    if (answer.Status === NXDOMAIN) return [];
    // Any other failure (SERVFAIL, REFUSED…) is not an answer.
    if (answer.Status !== 0) return null;
    // A CNAME rides in the same list ahead of the TXT it leads to.
    return (answer.Answer ?? [])
      .filter(({ type }) => type === TXT)
      .map(({ data }) => recordOf(data));
  } catch {
    return null;
  }
};

/**
 * `[]` when the name has no TXT record; `null` when the lookup failed. Answers (and in-flight
 * lookups) are kept for the session, failures are not.
 */
export const createTxtLookup = (
  fetchDoh: typeof fetch = fetch,
  now: () => number = Date.now,
): TxtLookup => {
  const answers = new Map<
    string,
    { readonly expiresAt: number; readonly records: Promise<readonly string[] | null> }
  >();
  return async name => {
    const known = answers.get(name);
    if (known !== undefined && known.expiresAt > now()) return known.records;
    const records = queryTxt(fetchDoh, name);
    answers.set(name, { expiresAt: now() + CACHE_MS, records });
    const found = await records;
    if (found === null && answers.get(name)?.records === records) answers.delete(name);
    return found;
  };
};
