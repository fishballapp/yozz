import type { BlockNode, InlineNode, MarkdownExtension, ParseOptions } from '@tanstack/markdown';
import { autolinksExtension } from '@tanstack/markdown/extensions/autolinks';

/** Nobody hard-wraps a message, so a newline in a draft is always a line the writer meant. */
const lineBreaks: MarkdownExtension = {
  name: 'line-breaks',
  inlineParser: { markers: '\n', parse: () => ({ node: { type: 'break' }, length: 1 }) },
};

const BOLD = /\*\*(?!\*)(\S(?:[\s\S]*?\S)?)\*\*(?!\*)/y;
const MARK_RUN = /([*_~])\1*/y;

/**
 * Bold is the one emphasis mail keeps. A lone `*`, `_` or `~` is a sum, a file name or a footnote
 * mark far more often than a wish for italics, so it stays as typed.
 */
const boldOnly: MarkdownExtension = {
  name: 'bold-only',
  inlineParser: {
    markers: '*_~',
    parse: ({ source, index, parseInline }) => {
      BOLD.lastIndex = index;
      const bold = BOLD.exec(source);
      if (bold !== null) {
        return {
          node: { type: 'strong', children: parseInline(bold[1] ?? '') },
          length: bold[0].length,
        };
      }
      MARK_RUN.lastIndex = index;
      const marks = MARK_RUN.exec(source)?.[0];
      if (marks === undefined) return undefined;
      return { node: { type: 'text', value: marks }, length: marks.length };
    },
  },
};

const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const TABLE_RULE = /^[\s|:-]*-[\s|:-]*$/;
const isTableHeader = (line: string, next: string | undefined) =>
  line.includes('|') && next !== undefined && next.includes('|') && TABLE_RULE.test(next);
// A line led by a letter opens no block of its own, so it carries the paragraph on.
const continuesParagraph = (line: string) => /^[a-z]/i.test(line) && !line.includes('|');

/**
 * A heading's size and a table's grid are each mail client's own guess, so a `#` line and a row of
 * `|` stay the lines that were typed.
 */
const plainHeadingsAndTables: MarkdownExtension = {
  name: 'plain-headings-and-tables',
  parseBlock: ({ lines, index, parseInline, consume }) => {
    const first = lines[index] ?? '';
    const rest = lines.slice(index + 1);
    const taken = (() => {
      if (HEADING.test(first)) return rest.findIndex(line => !continuesParagraph(line));
      if (isTableHeader(first, rest[0])) return rest.findIndex(line => !line.includes('|'));
      return undefined;
    })();
    if (taken === undefined) return undefined;
    const typed = [first, ...(taken === -1 ? rest : rest.slice(0, taken))];
    consume(typed.length);
    return { type: 'paragraph', children: parseInline(typed.map(line => line.trim()).join('\n')) };
  },
};

const withFootnoteNumbers = (nodes: InlineNode[]): InlineNode[] =>
  nodes.map(node => {
    if (node.type === 'footnoteReference') return { type: 'text', value: `[${node.number}]` };
    if ('children' in node) return { ...node, children: withFootnoteNumbers(node.children) };
    return node;
  });

/** A footnote's links jump between ids, which mail clients strip: the number and a numbered list say the same without them. */
const plainFootnotes: MarkdownExtension = {
  name: 'plain-footnotes',
  transformInline: withFootnoteNumbers,
  transformDocument: document => ({
    ...document,
    children: document.children.flatMap((block): BlockNode[] => {
      if (block.type !== 'footnotes') return [block];
      return [
        { type: 'thematicBreak' },
        {
          type: 'list',
          ordered: true,
          start: 1,
          items: block.items.map(({ children }) => ({ type: 'listItem', children })),
        },
      ];
    }),
  }),
};

const withWrittenTaskMarks = (blocks: BlockNode[]): BlockNode[] =>
  blocks.map(block => {
    if (block.type === 'blockquote') {
      return { ...block, children: withWrittenTaskMarks(block.children) };
    }
    if (block.type !== 'list') return block;
    return {
      ...block,
      items: block.items.map(({ checked, ...item }) => {
        const children = withWrittenTaskMarks(item.children);
        if (checked === undefined) return { ...item, children };
        const mark: InlineNode = { type: 'text', value: checked ? '[x] ' : '[ ] ' };
        const [first, ...rest] = children;
        if (first?.type !== 'paragraph') {
          return { ...item, children: [{ type: 'paragraph', children: [mark] }, ...children] };
        }
        return { ...item, children: [{ ...first, children: [mark, ...first.children] }, ...rest] };
      }),
    };
  });

/** A task list parses to a checkbox input, which mail clients strip: the item keeps the mark as it was typed. */
const writtenTaskMarks: MarkdownExtension = {
  name: 'written-task-marks',
  transformDocument: document => ({
    ...document,
    children: withWrittenTaskMarks(document.children),
  }),
};

/** Gmail's own rule for a quoted reply, so a quote reads as one in a client that styles none. */
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

const ruledQuotes: MarkdownExtension = {
  name: 'ruled-quotes',
  renderHtml: (node, { renderBlock }) => {
    if (node.type !== 'blockquote') return undefined;
    return `<blockquote style="${QUOTE_STYLE}">\n${node.children.map(renderBlock).join('\n')}\n</blockquote>`;
  },
};

/**
 * How a draft's markdown is read, by the preview and by the HTML part that is sent: the same
 * options in both. Mail is plain text with a few marks, so what is not one of them stays as typed,
 * and nothing is in the output that a mail client would drop.
 */
export const MAIL_MARKDOWN = {
  extensions: [
    autolinksExtension(),
    lineBreaks,
    boldOnly,
    plainHeadingsAndTables,
    // Before `writtenTaskMarks`, which walks the list this makes.
    plainFootnotes,
    writtenTaskMarks,
    ruledQuotes,
  ],
} satisfies ParseOptions;
