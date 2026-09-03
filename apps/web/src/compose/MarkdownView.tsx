import { Markdown, type MarkdownComponents } from '@tanstack/markdown/react';

/** Renders a markdown draft the way the recipient will read it. Every element is mapped: an unmapped tag would render with browser defaults and lie about what gets sent. */
const COMPONENTS: MarkdownComponents = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  // The same scheme allowlist as renderHtml()'s sent alternative; received mail is stricter and does not belong here.
  a: ({ children, href }) => (
    <a
      href={href}
      rel="noreferrer noopener"
      target="_blank"
      className="text-signal underline underline-offset-2"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-paper">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 text-[17px] font-medium tracking-[-0.01em] text-paper first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 text-[15px] font-medium text-paper first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1.5 text-base font-semibold text-paper first:mt-0">{children}</h3>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  // The quoted original in a reply: a hairline on the leading edge and dimmer ink.
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l border-rule pl-3 text-paper-dim">{children}</blockquote>
  ),
  code: ({ children }) => (
    <code className="bg-ink px-1 py-0.5 font-mono text-2xs text-paper">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto bg-ink p-3 font-mono text-2xs text-paper">{children}</pre>
  ),
  hr: () => <hr className="my-4 border-rule-soft" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="label-rule border-b border-rule py-1.5 pr-3">{children}</th>,
  td: ({ children }) => <td className="border-b border-rule-soft py-1.5 pr-3">{children}</td>,
};

export const MarkdownView = ({ source }: { source: string }) => (
  <div className="max-w-[68ch] text-[13.5px] leading-[1.65] text-paper">
    <Markdown components={COMPONENTS}>{source}</Markdown>
  </div>
);
