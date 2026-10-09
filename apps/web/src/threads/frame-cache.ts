import type { MailFrame } from './html';

// ponytail: bounded by count, not bytes; 32 messages near the 8M-code-unit render ceiling would
// hold ~1 GB. Un-park if a tab is seen dying after a long session of image-heavy mail.
const MAX_FRAMES = 32;

/** Insertion order is recency: a hit is re-inserted, and the first key is the one evicted. */
const frames = new Map<string, MailFrame>();

/**
 * A sanitised frame per HTML, so reopening a message skips DOMPurify. Keyed by the bytes because
 * the frame is a function of them alone (its ground included); two messages sharing a Message-ID
 * cannot share a frame unless they share every byte.
 */
export const cachedFrameOf = (html: string, build: () => MailFrame): MailFrame => {
  const frame = frames.get(html) ?? build();
  frames.delete(html);
  frames.set(html, frame);
  const [oldest] = frames.keys();
  if (frames.size > MAX_FRAMES && oldest !== undefined) frames.delete(oldest);
  return frame;
};

/** The frames are mail plaintext, so they go with the rest of the session's mail state. */
export const clearCachedFrames = (): void => frames.clear();
