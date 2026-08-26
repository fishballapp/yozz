import { Children, isValidElement, type ReactNode } from 'react';
import { outboundHrefOf } from '../mail/url-policy';

/**
 * Turn bare URLs and email addresses in plain text into real links.
 *
 * Mail is full of unlinked URLs — machine senders paste them raw and people type them mid-sentence
 * — so a client that leaves them as dead text makes you select-and-copy. TanStack Markdown does not
 * autolink, so this runs at RENDER time rather than on the markdown source: it only ever sees the
 * text inside the elements it is applied to, which means it can never reach into a code span or a
 * fenced block and corrupt them. That is the whole reason it is not a string pre-processor.
 *
 * Trailing sentence punctuation is deliberately excluded from the match, so
 * "see https://example.com." links the URL and leaves the full stop as prose.
 */
/**
 * The email local part is BOUNDED (RFC 5321 caps it at 64 anyway). Unbounded, `[\w.+-]+@` makes
 * `split` quadratic: it retries every start offset, swallows the whole run, then backtracks one
 * character at a time looking for an `@` that never comes. Measured on a 64 KB run of word
 * characters — ordinary mail content, a base64 blob or a DKIM signature — that was 7.1 seconds of
 * frozen main thread; bounded it is 15 ms.
 */
const PATTERN =
  /(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]|www\.[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]|[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{0,251}[\w-])/g;

/**
 * Tests for a SCHEME, not for the prefix "http": `http@evil.com` is a legal address whose local
 * part starts with those four characters, and treating it as a URL produced a relative href that
 * navigated the SPA instead of opening a composer.
 */
const hrefFor = (match: string) => {
  if (match.includes('://')) return match;
  if (match.startsWith('www.')) return `https://${match}`;
  return `mailto:${match}`;
};

const linkifyString = (text: string, keyPrefix: string): ReactNode[] =>
  text.split(PATTERN).map((part, index) => {
    // Odd indices are the captured matches; even indices are the plain text between them.
    if (index % 2 === 0) return part;
    const href = outboundHrefOf(hrefFor(part));
    if (href === null) return part;
    return (
      <a
        key={`${keyPrefix}-${index}`}
        href={href}
        rel="noreferrer noopener"
        target="_blank"
        className="text-signal underline underline-offset-2 hover:no-underline"
      >
        {part}
      </a>
    );
  });

/** Walks children, linkifying only the string leaves and leaving elements untouched. */
export const linkify = (node: ReactNode, keyPrefix = 'l'): ReactNode => {
  if (typeof node === 'string') return linkifyString(node, keyPrefix);
  if (Array.isArray(node))
    return Children.map(node, (child, index) => linkify(child, `${keyPrefix}${index}`));
  // An element already carries its own semantics (a real markdown link, `code`, emphasis) — do not
  // descend into it. Its own renderer decides whether its text is linkifiable.
  if (isValidElement(node)) return node;
  return node;
};
