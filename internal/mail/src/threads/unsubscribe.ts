/**
 * What a message's `List-Unsubscribe` header (RFC 2369) offers. Only the two forms a person can
 * safely act on: an `https:` link to open, a `mailto:` address to write to. `http:` and every other
 * scheme are dropped, and so is RFC 8058's one-click POST, which no client here ever sends
 * ([DECISIONS](../../../../DECISIONS.md#2026-11-09--unsubscribe-opens-a-link-or-writes-a-draft-and-never-posts)).
 */
export type Unsubscribe = {
  readonly https?: string;
  readonly mailto?: string;
};

/** The header is the sender's; a URI longer than any link worth following is not read. */
export const MAX_URI_CHARS = 2048;

/** A `<…>` item of the header's list; the angle brackets cannot occur inside a URI (RFC 3986). */
const ITEM_PATTERN = /<([^<>]*)>/g;

/** What a `mailto:` URI asks the composer to start (RFC 6068): the address, and a subject and body when it names them. */
export type MailtoDraft = {
  readonly to: string;
  readonly subject?: string;
  readonly body?: string;
};

/** Percent-decoding that stays total; a `+` is a plus here, unlike in a form (RFC 6068 §2). */
const decoded = (text: string): string | null => {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
};

/** Mail text uses CRLF; the composer holds LF. */
const lineFeeds = (text: string) => text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');

/**
 * The draft a `mailto:` URI starts, or null when it names no address. `cc`, `bcc` and the rest of
 * its header fields are ignored: an unsubscribe address is written to alone.
 */
export const mailtoDraftOf = (uri: string): MailtoDraft | null => {
  if (!/^mailto:/i.test(uri)) return null;
  const [path = '', query = ''] = uri.slice('mailto:'.length).split(/\?(.*)/s, 2);
  const to = decoded(path)?.trim();
  if (to === undefined || !/^[^\s@,;<>]+@[^\s@,;<>]+$/.test(to)) return null;
  const fields = new Map(
    query
      .split('&')
      .map(pair => pair.split(/=(.*)/s, 2))
      .flatMap(([name = '', value = '']) => {
        const text = decoded(value);
        return text === null ? [] : [[name.toLowerCase(), lineFeeds(text)] as const];
      })
      .toReversed(),
  );
  const subject = fields.get('subject');
  const body = fields.get('body');
  return {
    to,
    // A subject is one line.
    ...(subject === undefined || subject === '' ? {} : { subject: subject.replaceAll('\n', ' ') }),
    ...(body === undefined || body === '' ? {} : { body }),
  };
};

/**
 * The offer in a `List-Unsubscribe` value, or null when it has none we act on. The first `https:`
 * and the first `mailto:` URI win; a `mailto:` that names no address is not an offer.
 */
export const unsubscribeOf = (header: string | undefined): Unsubscribe | null => {
  if (header === undefined) return null;
  // A long URI may be folded anywhere (RFC 2369 §2), so whitespace inside the brackets is no part of it.
  const uris = Array.from(header.matchAll(ITEM_PATTERN), ([, uri = '']) =>
    uri.replaceAll(/\s+/g, ''),
  ).filter(uri => uri.length <= MAX_URI_CHARS);
  const https = uris.find(uri => /^https:\/\/[^/?#]/i.test(uri) && URL.canParse(uri));
  const mailto = uris.find(uri => mailtoDraftOf(uri) !== null);
  if (https === undefined && mailto === undefined) return null;
  return {
    ...(https === undefined ? {} : { https }),
    ...(mailto === undefined ? {} : { mailto }),
  };
};
