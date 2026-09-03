import { type MailAutoconfig, MailAutoconfigSchema } from '@yozz.app/vault-contract';
import { getApiBaseUrl } from '../vault/api-base-url';

/**
 * Asks the Worker what a domain publishes about its mail servers. Only the domain travels: the
 * address itself stays here, so the server learns no more than the relay already does.
 */

export type AutoconfigLookup =
  | { readonly status: 'found'; readonly config: MailAutoconfig }
  /** The domain publishes nothing the relay can use. Hand-entry is the normal next step. */
  | { readonly status: 'none' }
  /** The lookup itself did not happen — no session, no network, a refused request. */
  | { readonly status: 'unavailable' };

/** The part after the last `@`, lowercased, when it has at least two labels. */
export const domainOf = (address: string): string | null => {
  const at = address.lastIndexOf('@');
  if (at === -1) return null;
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return /^[^\s@.]+(\.[^\s@.]+)+$/.test(domain) ? domain : null;
};

export const lookupMailServers = async (
  domain: string,
  fetchFn: typeof fetch = fetch,
): Promise<AutoconfigLookup> => {
  try {
    const base = getApiBaseUrl().replace(/\/+$/, '');
    const res = await fetchFn(`${base}/api/v1/autoconfig?domain=${encodeURIComponent(domain)}`, {
      credentials: 'include',
    });
    if (res.status === 404) return { status: 'none' };
    if (!res.ok) return { status: 'unavailable' };
    const parsed = MailAutoconfigSchema.safeParse(await res.json());
    return parsed.success ? { status: 'found', config: parsed.data } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
};

/** What the person logs in as, given how the provider says it wants it. */
export const usernameFor = (address: string, form: MailAutoconfig['username']): string =>
  form === 'localpart' ? address.slice(0, address.lastIndexOf('@')) : address;

/** One phrase naming where the servers came from, for the form to cite. */
export const describeSource = (config: MailAutoconfig): string => {
  switch (config.source) {
    case 'provider':
      return `${config.sourceDomain}'s published configuration`;
    case 'ispdb':
      return `the Thunderbird ISPDB entry for ${config.sourceDomain}`;
    case 'srv':
      return `${config.sourceDomain}'s DNS records`;
  }
};
