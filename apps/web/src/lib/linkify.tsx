import { Children, isValidElement, type ReactNode } from 'react';
import { outboundHrefOf } from '../mail/url-policy';

/**
 * Runs at render time on string leaves only, so it can never reach into a code span or fenced
 * block. Trailing sentence punctuation is excluded from the match.
 */
/** Bounded (RFC 5321 caps the local part at 64): unbounded, `[\w.+-]+@` is quadratic on a 64 KB run (7.1 s measured; bounded, 15 ms). */
const PATTERN =
  /(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]|www\.[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]|[\w.+-]{1,64}@[\w-]{1,63}\.[\w.-]{0,251}[\w-])/g;

/** A scheme, not the prefix "http": `http@evil.com` is a legal address. */
const hrefFor = (match: string) => {
  if (match.includes('://')) return match;
  if (match.startsWith('www.')) return `https://${match}`;
  return `mailto:${match}`;
};

const linkifyString = (text: string, keyPrefix: string): ReactNode[] =>
  text.split(PATTERN).map((part, index) => {
    // Odd indices are the captured matches.
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

/** Linkifies only the string leaves. */
export const linkify = (node: ReactNode, keyPrefix = 'l'): ReactNode => {
  if (typeof node === 'string') return linkifyString(node, keyPrefix);
  if (Array.isArray(node))
    return Children.map(node, (child, index) => linkify(child, `${keyPrefix}${index}`));
  // An element carries its own semantics; its renderer decides.
  if (isValidElement(node)) return node;
  return node;
};
