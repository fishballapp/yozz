const ABSOLUTE_WEB_URL = /^https?:\/\//i;
const PROTOCOL_RELATIVE_URL = /^\/\//;
const APP_HOST = /(?:^|\.)yozz\.app$/i;
const SAFE_DNS_HOSTNAME = /^[a-z0-9._-]+$/i;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
};

// The URL Standard removes ASCII tab/newline before parsing. Mail generators legitimately fold
// long attributes with those characters, so normalize them while continuing to reject every other
// C0 control and DEL instead of letting `trim()` hide one at an edge.
export const normalizedUrlInputOf = (value: string): string | null => {
  const normalized = value.replace(/[\t\n\r]/g, '');
  if (hasControlCharacter(normalized)) return null;
  const trimmed = normalized.trim();
  return trimmed === '' ? null : trimmed;
};

const normalizedHostnameOf = (hostname: string): string => hostname.replace(/\.+$/, '');

/** Shared by the HTML frame and plain-text autolinker: authenticated YOZZ is never mail-linked. */
export const isPermittedExternalHostname = (hostname: string): boolean =>
  SAFE_DNS_HOSTNAME.test(hostname) && !APP_HOST.test(normalizedHostnameOf(hostname));

/** Parse before trusting: URL's scheme parser accepts surprising slashless and backslash forms. */
export const outboundHrefOf = (value: string): string | null => {
  const trimmed = normalizedUrlInputOf(value);
  if (trimmed === null) return null;

  if (/^(?:mailto|tel):/i.test(trimmed)) {
    try {
      return new URL(trimmed).href;
    } catch {
      return null;
    }
  }

  const candidate = PROTOCOL_RELATIVE_URL.test(trimmed) ? `https:${trimmed}` : trimmed;
  if (!ABSOLUTE_WEB_URL.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if (url.username !== '' || url.password !== '' || !isPermittedExternalHostname(url.hostname))
      return null;
    return url.href;
  } catch {
    return null;
  }
};
