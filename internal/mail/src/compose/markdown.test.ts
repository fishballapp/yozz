import { renderHtml } from '@tanstack/markdown/html';
import { describe, expect, it } from 'vitest';
import { MAIL_MARKDOWN } from './markdown.ts';

const htmlOf = (source: string) => renderHtml(source, MAIL_MARKDOWN);

describe('a line break in a draft', () => {
  it('is a line break in the message', () => {
    expect(htmlOf('Thanks,\nJason')).toBe('<p>Thanks,<br>Jason</p>');
  });

  it('keeps the lines of a quoted reply apart', () => {
    expect(htmlOf('> 12 Mill Lane\n> Leeds')).toBe(
      '<blockquote>\n<p>12 Mill Lane<br>Leeds</p>\n</blockquote>',
    );
  });

  it('breaks inside bold, a link label and a list item', () => {
    expect(htmlOf('**a\nb**')).toBe('<p><strong>a<br>b</strong></p>');
    expect(htmlOf('[a\nb](https://example.com)')).toBe(
      '<p><a href="https://example.com">a<br>b</a></p>',
    );
    expect(htmlOf('- a\nb')).toBe('<ul>\n<li>a<br>b</li>\n</ul>');
  });

  it('still parts paragraphs on a blank line', () => {
    expect(htmlOf('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>');
  });

  it('leaves code as it was typed', () => {
    expect(htmlOf('`a\nb`')).toBe('<p><code>a b</code></p>');
    expect(htmlOf('```\na\nb\n```')).toContain('a\nb</code>');
  });
});

describe('a pasted URL', () => {
  it('is a link, without the punctuation after it', () => {
    expect(htmlOf('See https://example.com/pay.')).toBe(
      '<p>See <a href="https://example.com/pay">https://example.com/pay</a>.</p>',
    );
  });

  it('is a link in angle brackets, which are not shown', () => {
    expect(htmlOf('<https://example.com>')).toBe(
      '<p><a href="https://example.com">https://example.com</a></p>',
    );
  });

  it('stays text in code, and is not linked twice in a link', () => {
    expect(htmlOf('`https://example.com`')).toBe('<p><code>https://example.com</code></p>');
    expect(htmlOf('[https://example.com](https://example.org)')).toBe(
      '<p><a href="https://example.org">https://example.com</a></p>',
    );
  });
});

describe('what a mail client would drop', () => {
  it('gives a heading no id', () => {
    expect(htmlOf('# Invoice')).toBe('<h1>Invoice</h1>');
  });

  it('writes a task mark as typed, never a checkbox', () => {
    expect(htmlOf('- [ ] book\n- [x] pay\n- plain')).toBe(
      '<ul>\n<li>[ ] book</li>\n<li>[x] pay</li>\n<li>plain</li>\n</ul>',
    );
    expect(htmlOf('> - [x] quoted\n>   - [ ] nested')).not.toContain('<input');
  });

  it('writes a footnote as a number and a numbered list, with no links between them', () => {
    expect(htmlOf('Paid **in full[^a]**.\n\n[^a]: On 3 May.')).toBe(
      '<p>Paid <strong>in full[1]</strong>.</p>\n<hr>\n<ol>\n<li>On 3 May.</li>\n</ol>',
    );
  });
});
