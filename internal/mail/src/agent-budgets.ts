/**
 * How much an agent is handed per answer, shared by the WebMCP tools and the CLI. Chrome's guidance
 * is ~1.5K characters per tool output, and ChatGPT quotes results verbatim.
 */

export const LIST_LIMIT_DEFAULT = 20;
export const LIST_LIMIT_MAX = 50;
export const BATCH_MAX = 50;
export const SNIPPET_CHARS = 120;
export const BODY_CHARS = 1_500;
export const BODY_CHARS_MAX = 6_000;
export const OUTPUT_CHARS = 6_000;
/** How deep each `body` mode goes. */
export const DEPTH: Record<'none' | 'latest' | 'full', number> = { none: 50, latest: 10, full: 3 };
/** A skim gets a short body per thread, so ten still fit one output. */
export const SKIM_CHARS = 400;
/** Per `to` / `cc` line: a list mail to hundreds must not spend the whole output on its header. */
export const RECIPIENTS_LISTED = 10;

/** `text` cut to `max`, saying how much went, never between the two halves of a surrogate pair. */
export const clip = (text: string, max: number) => {
  if (text.length <= max) return text;
  // The last unit kept is a high surrogate: its low half would go, so it goes too.
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end)}…[truncated ${text.length - end} chars]`;
};

/** The largest prefix of `items` whose JSON fits `budget`, never fewer than one. */
export const fitting = <T>(items: readonly T[], budget: number): readonly T[] => {
  const sizes = items.map(item => JSON.stringify(item).length);
  const count = (() => {
    let total = 0;
    for (const [index, size] of sizes.entries()) {
      total += size;
      if (total > budget) return Math.max(1, index);
    }
    return items.length;
  })();
  return items.slice(0, count);
};
