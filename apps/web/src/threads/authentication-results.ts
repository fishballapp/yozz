import { addressParser } from 'postal-mime';
import { senderKeyOf } from './remote-images';

/**
 * Whether the person's own mail provider vouched for a message's From address: DMARC passed,
 * aligned with the From domain, in an `Authentication-Results` header (RFC 8601) that provider
 * stamped. A header is the provider's only when it carries the provider's `authserv-id` AND sits
 * where the provider writes it — on top, since every hop prepends — because anything below is the
 * sender's to write (RFC 8601 §5). Providers and shapes: docs/knowledge/authentication-results.md.
 */

/** A header as `postal-mime` gives it: lowercase key, unfolded value, document order. */
export type MailHeader = { readonly key: string; readonly value: string };

type MethodResult = {
  readonly method: string;
  readonly result: string;
  /** `ptype.property` → value, keys lowercased (`header.from`, `smtp.mailfrom`). */
  readonly properties: Readonly<Record<string, string>>;
};

export type AuthenticationResults = {
  /** Null when the header names none, which Microsoft's never does. */
  readonly authservId: string | null;
  readonly results: readonly MethodResult[];
};

/**
 * `one-header`: the provider writes every verdict into one header, so only the topmost header
 * counts, and a DMARC verdict missing from it (Gmail omits it for a domain with no record) is not
 * looked for further down, where a sender could have written one. `per-method`: one header per
 * method under the same id, so the verdict is read from the run of the provider's headers at the
 * top, ending at the first header someone else stamped.
 */
// ponytail: a per-method provider whose run carried no `dmarc` result at all would let a sender's
// own header with the provider's id, directly under the run, supply one. Fastmail writes
// `dmarc=none` when a domain publishes no record, so this needs its DMARC check to have been
// skipped outright (a lookup that errored or timed out): rare, and the cost is one pixel from a
// sender you already trust. Un-park if a Fastmail message with no `dmarc` result is seen.
type Layout = 'one-header' | 'per-method';

type Provider = {
  /** IMAP hosts, lowercase: which account's mail this provider stamped. */
  readonly imapHosts: readonly string[];
  readonly isAuthservId: (id: string | null) => boolean;
  readonly layout: Layout;
};

const PROVIDERS = {
  // Google Workspace on a custom domain reads over the same host and is stamped the same way.
  google: {
    imapHosts: ['imap.gmail.com', 'imap.googlemail.com'],
    isAuthservId: id => id === 'mx.google.com',
    layout: 'one-header',
  },
  // Exchange Online writes no authserv-id at all (`Authentication-Results: spf=pass …`), so
  // position is all there is: the topmost header, in that id-less form.
  microsoft: {
    imapHosts: ['outlook.office365.com', 'imap-mail.outlook.com'],
    isAuthservId: id => id === null,
    layout: 'one-header',
  },
  // A host of the receiving cluster, such as `atlas220.free.mail.bf1.yahoo.com`.
  yahoo: {
    imapHosts: ['imap.mail.yahoo.com'],
    isAuthservId: id => id !== null && /^atlas[a-z0-9.-]*\.yahoo\.com$/.test(id),
    layout: 'one-header',
  },
  // iCloud is absent until a real raw message shows it always writes its own `dmarc` result
  // (docs/knowledge/authentication-results.md): unverified, it is the gap above with no bound.
  // The receiving MX, such as `phl-mx-04.messagingengine.com`, one header per method.
  fastmail: {
    imapHosts: ['imap.fastmail.com'],
    isAuthservId: id => id !== null && /^[a-z0-9-]+\.messagingengine\.com$/.test(id),
    layout: 'per-method',
  },
} as const satisfies Record<string, Provider>;

const providerOf = (imapHost: string): Provider | undefined => {
  const host = imapHost.trim().toLowerCase().replace(/\.$/, '');
  return Object.values<Provider>(PROVIDERS).find(provider => provider.imapHosts.includes(host));
};

/**
 * Comments, nested or not, become a space; quoted strings are kept whole, so `(` in one is text.
 * Null when a comment holds a `"` or a quote is left open: a provider copying a sender's quoted
 * local part into a comment would let that sender's `)` end the comment wherever it liked.
 */
const withoutComments = (value: string): string | null => {
  let out = '';
  let depth = 0;
  let isQuoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\') {
      if (depth === 0) out += value.slice(index, index + 2);
      index++;
      continue;
    }
    if (char === '"') {
      if (depth > 0) return null;
      isQuoted = !isQuoted;
    }
    if (!isQuoted && char === '(') {
      depth++;
      if (depth === 1) out += ' ';
      continue;
    }
    if (!isQuoted && depth > 0 && char === ')') {
      depth--;
      continue;
    }
    if (depth === 0) out += char;
  }
  return isQuoted || depth > 0 ? null : out;
};

/** Splits on `;` outside quoted strings. */
const segmentsOf = (value: string): string[] =>
  Array.from(value.matchAll(/(?:"(?:[^"\\]|\\.)*"|[^;"])+/g), match => match[0].trim()).filter(
    segment => segment !== '',
  );

const unquoted = (value: string) =>
  value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;

const PAIR = /([^\s=]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s"]+)/g;

const methodResultOf = (segment: string): MethodResult | null => {
  const [first, ...rest] = Array.from(segment.matchAll(PAIR), ([, key = '', value = '']) => ({
    key: key.toLowerCase(),
    value: unquoted(value),
  }));
  if (first === undefined) return null;
  return {
    // `dkim/1=pass`: the method's version is not part of its name.
    method: first.key.replace(/\/.*$/, ''),
    result: first.value.toLowerCase(),
    properties: Object.fromEntries(rest.map(({ key, value }) => [key, value])),
  };
};

/** Total: a value this cannot read is null, which no provider's rule accepts. */
export const parseAuthenticationResults = (value: string): AuthenticationResults | null => {
  const readable = withoutComments(value);
  if (readable === null) return null;
  const [head, ...rest] = segmentsOf(readable);
  if (head === undefined) return null;
  // Microsoft's form opens straight on a result: `spf=pass …`.
  if (head.includes('=')) {
    const results = [head, ...rest].map(methodResultOf);
    return results.every(result => result !== null) ? { authservId: null, results } : null;
  }
  // The id, then an optional version number.
  const [authservId, version, ...junk] = head.split(/\s+/);
  if (authservId === undefined || junk.length > 0) return null;
  if (version !== undefined && !/^\d+$/.test(version)) return null;
  // `none` says no method ran.
  const results = rest.filter(segment => segment.toLowerCase() !== 'none').map(methodResultOf);
  return results.every(result => result !== null)
    ? { authservId: authservId.toLowerCase(), results }
    : null;
};

/**
 * The DMARC verdict the provider stamped, read only from where its own headers sit. A provider
 * writes one; a second in the run means something there is not the provider's, so neither counts.
 */
const providerDmarc = (
  provider: Provider,
  stamped: readonly (AuthenticationResults | null)[],
): MethodResult | undefined => {
  const isProviders = (header: AuthenticationResults | null): header is AuthenticationResults =>
    header !== null && provider.isAuthservId(header.authservId);
  const firstForeign = stamped.findIndex(header => !isProviders(header));
  const run =
    provider.layout === 'one-header'
      ? stamped.slice(0, 1)
      : stamped.slice(0, firstForeign === -1 ? undefined : firstForeign);
  const verdicts = run
    .filter(isProviders)
    .flatMap(header => header.results)
    .filter(result => result.method === 'dmarc');
  return verdicts.length === 1 ? verdicts[0] : undefined;
};

/** The one mailbox of the one From header, or null for anything DMARC would not read as one author. */
const singleFrom = (headers: readonly MailHeader[]): string | null => {
  const froms = headers.filter(header => header.key === 'from');
  const [from] = froms;
  if (from === undefined || froms.length > 1) return null;
  const parsed = addressParser(from.value);
  const [mailbox] = parsed;
  if (mailbox === undefined || parsed.length > 1 || mailbox.address === undefined) return null;
  const at = mailbox.address.lastIndexOf('@');
  if (at <= 0 || at === mailbox.address.length - 1) return null;
  return mailbox.address;
};

/**
 * The From address, when the account's provider says DMARC passed for its domain; null whenever
 * that cannot be established — an unknown provider, no header of its own on top, any other verdict,
 * a `header.from` naming another domain, or a From that is not `shownFrom`, the address the reader
 * shows (IMAP's ENVELOPE, parsed elsewhere), so images never load for a sender other than the one
 * on screen.
 */
export const authenticatedSenderOf = (
  headers: readonly MailHeader[],
  imapHost: string,
  shownFrom: string,
): string | null => {
  const provider = providerOf(imapHost);
  if (provider === undefined) return null;
  const from = singleFrom(headers);
  if (from === null || senderKeyOf(from) !== senderKeyOf(shownFrom)) return null;
  const stamped = headers
    .filter(header => header.key === 'authentication-results')
    .map(header => parseAuthenticationResults(header.value));
  const dmarc = providerDmarc(provider, stamped);
  if (dmarc?.result !== 'pass') return null;
  const fromDomain = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
  return dmarc.properties['header.from']?.toLowerCase() === fromDomain ? from : null;
};
