import type { MailAutoconfig, MailServer } from '@yozz.app/vault-contract';
import { z } from 'zod';
import { parseClientConfig, usableServer, usernameForm } from './clientconfig.ts';

/**
 * Where a domain says its mail servers are, tried the way Thunderbird tries them: the provider's
 * own autoconfig URLs, then the Thunderbird ISPDB, then both again under the domain of the MX
 * host (a custom domain hosted at Fastmail, Google or Forward Email answers this way), then
 * RFC 6186 SRV records. Everything runs at once and the first answer in that order wins.
 *
 * Only the DOMAIN is looked up. The address's local part never leaves the browser, so the
 * server learns no more than the relay already does when it opens the socket.
 */

const TIMEOUT_MS = 4000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const fetchText = async (fetchFn: FetchLike, url: string): Promise<string | null> => {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
};

const DnsAnswerSchema = z.object({
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** Every answer's `data` for one record type, over Cloudflare's DNS-over-HTTPS. */
const dnsData = async (
  fetchFn: FetchLike,
  name: string,
  type: 'MX' | 'SRV',
): Promise<readonly string[]> => {
  const wanted = type === 'MX' ? 15 : 33;
  try {
    const res = await fetchFn(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!res.ok) return [];
    const parsed = DnsAnswerSchema.safeParse(await res.json());
    if (!parsed.success) return [];
    return (parsed.data.Answer ?? []).filter(a => a.type === wanted).map(a => a.data);
  } catch {
    return [];
  }
};

type Found = Omit<MailAutoconfig, 'sourceDomain'>;

const fromClientConfig = (xml: string, source: 'provider' | 'ispdb'): Found | null => {
  const config = parseClientConfig(xml);
  const imap = usableServer(config.imap, 993);
  const smtp = usableServer(config.smtp, 465);
  const named = imap ?? smtp;
  if (named === null) return null;
  return {
    imap: imap === null ? null : { host: imap.host, port: 993 },
    smtp: smtp === null ? null : { host: smtp.host, port: 465 },
    username: usernameForm(named),
    source,
  };
};

const providerUrls = (domain: string) => [
  `https://autoconfig.${domain}/mail/config-v1.1.xml`,
  `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
];

const ispdbUrl = (domain: string) =>
  `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`;

const firstConfig = async (
  fetchFn: FetchLike,
  urls: readonly string[],
  source: 'provider' | 'ispdb',
): Promise<Found | null> => {
  for (const url of urls) {
    const xml = await fetchText(fetchFn, url);
    const found = xml === null ? null : fromClientConfig(xml, source);
    if (found !== null) return found;
  }
  return null;
};

/**
 * `in1-smtp.messagingengine.com` → `messagingengine.com`; `aspmx.l.google.com` → `l.google.com`,
 * `google.com`. The ISPDB keys the shared providers under their MX domains for exactly this.
 */
export const mxDomains = (mxHost: string): readonly string[] => {
  const labels = mxHost.toLowerCase().replace(/\.$/, '').split('.');
  // A two-label MX host is already the provider's domain.
  if (labels.length === 2) return [labels.join('.')];
  const domains: string[] = [];
  for (let start = 1; start <= labels.length - 2; start += 1) {
    domains.push(labels.slice(start).join('.'));
  }
  return domains;
};

const lowestMx = (records: readonly string[]): string | null => {
  let best: { priority: number; host: string } | null = null;
  for (const record of records) {
    const [priority, host] = record.split(/\s+/);
    if (host === undefined) continue;
    const n = Number(priority);
    if (!Number.isFinite(n)) continue;
    if (best === null || n < best.priority) best = { priority: n, host };
  }
  return best?.host ?? null;
};

/**
 * Under the MX host's domain, both the provider's own file and the ISPDB are tried. Thunderbird
 * checks only the ISPDB here, which misses a provider that publishes autoconfig but is not in the
 * database — Forward Email, for one.
 */
const viaMx = async (
  fetchFn: FetchLike,
  domain: string,
): Promise<(Found & { sourceDomain: string }) | null> => {
  const mx = lowestMx(await dnsData(fetchFn, domain, 'MX'));
  if (mx === null) return null;
  for (const candidate of mxDomains(mx)) {
    const found =
      (await firstConfig(fetchFn, providerUrls(candidate), 'provider')) ??
      (await firstConfig(fetchFn, [ispdbUrl(candidate)], 'ispdb'));
    if (found !== null) return { ...found, sourceDomain: candidate };
  }
  return null;
};

/**
 * `0 1 993 imap.fastmail.com` → the target, chosen the way RFC 2782 says: lowest priority first,
 * heaviest weight within it (deterministically — a client adding one address is not balancing a
 * fleet), and a target of `.` means the service is deliberately absent. Only a record on the
 * one port the relay can use counts.
 */
export const srvTarget = (records: readonly string[], port: MailServer['port']): string | null => {
  const usable = records.flatMap(record => {
    const [priority, weight, recordPort, target] = record.split(/\s+/);
    if (target === undefined || Number(recordPort) !== port) return [];
    return [{ priority: Number(priority), weight: Number(weight), target }];
  });
  usable.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const best = usable[0];
  if (best === undefined || best.target === '.') return null;
  const host = best.target.toLowerCase().replace(/\.$/, '');
  return host === '' ? null : host;
};

const viaSrv = async (fetchFn: FetchLike, domain: string): Promise<Found | null> => {
  const [imaps, submissions] = await Promise.all([
    dnsData(fetchFn, `_imaps._tcp.${domain}`, 'SRV'),
    dnsData(fetchFn, `_submissions._tcp.${domain}`, 'SRV'),
  ]);
  const imap = srvTarget(imaps, 993);
  const smtp = srvTarget(submissions, 465);
  if (imap === null && smtp === null) return null;
  return {
    imap: imap === null ? null : { host: imap, port: 993 },
    smtp: smtp === null ? null : { host: smtp, port: 465 },
    // SRV says where, never who: the whole address is what nearly every provider wants.
    username: 'address',
    source: 'srv',
  };
};

export const lookupMailServers = async (
  domain: string,
  fetchFn: FetchLike = fetch,
): Promise<MailAutoconfig | null> => {
  const [provider, ispdb, mx, srv] = await Promise.all([
    firstConfig(fetchFn, providerUrls(domain), 'provider'),
    firstConfig(fetchFn, [ispdbUrl(domain)], 'ispdb'),
    viaMx(fetchFn, domain),
    viaSrv(fetchFn, domain),
  ]);
  const direct = provider ?? ispdb;
  if (direct !== null) return { ...direct, sourceDomain: domain };
  if (mx !== null) return mx;
  if (srv !== null) return { ...srv, sourceDomain: domain };
  return null;
};
