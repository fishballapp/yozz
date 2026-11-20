import type { BlockNode, InlineNode, MarkdownExtension, ParseOptions } from '@tanstack/markdown';
import { autolinksExtension } from '@tanstack/markdown/extensions/autolinks';

/** Nobody hard-wraps a message, so a newline in a draft is always a line the writer meant. */
const lineBreaks: MarkdownExtension = {
  name: 'line-breaks',
  inlineParser: { markers: '\n', parse: () => ({ node: { type: 'break' }, length: 1 }) },
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

/**
 * How a draft's markdown is read, by the preview and by the HTML part that is sent: the same
 * options in both, and nothing in the output that a mail client would drop.
 */
export const MAIL_MARKDOWN = {
  // A heading's id is for in-page links, which mail has none of.
  headingIds: false,
  // `plainFootnotes` first: the list it makes is walked by `writtenTaskMarks`.
  extensions: [autolinksExtension(), lineBreaks, plainFootnotes, writtenTaskMarks],
} satisfies ParseOptions;
