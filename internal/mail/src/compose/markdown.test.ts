import { renderHtml } from '@tanstack/markdown/html';
import { describe, expect, it } from 'vitest';
import { MAIL_MARKDOWN } from './markdown.ts';

const htmlOf = (source: string) => renderHtml(source, MAIL_MARKDOWN);
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex';

describe('a line break in a draft', () => {
  it('is a line break in the message', () => {
    expect(htmlOf('Thanks,\nJason')).toBe('<p>Thanks,<br>Jason</p>');
  });

  it('keeps the lines of a quoted reply apart', () => {
    expect(htmlOf('> 12 Mill Lane\n> Leeds')).toBe(
      `<blockquote style="${QUOTE_STYLE}">\n<p>12 Mill Lane<br>Leeds</p>\n</blockquote>`,
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

describe('the marks mail keeps', () => {
  it('makes bold of two stars, around a link and inside one too', () => {
    expect(htmlOf('Due **Friday**.')).toBe('<p>Due <strong>Friday</strong>.</p>');
    expect(htmlOf('[**pay**](https://example.com/a_b)')).toBe(
      '<p><a href="https://example.com/a_b"><strong>pay</strong></a></p>',
    );
  });

  it('keeps a list, a rule and code', () => {
    expect(htmlOf('* one\n* two')).toBe('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(htmlOf('Thanks\n---\nJason')).toBe('<p>Thanks</p>\n<hr>\n<p>Jason</p>');
    expect(htmlOf('`*x*` and \\*y\\*')).toBe('<p><code>*x*</code> and *y*</p>');
  });

  it('rules a quote, and a quote in a quote, for a client that styles neither', () => {
    expect(htmlOf('> > older\n> newer\n\nmine')).toBe(
      [
        `<blockquote style="${QUOTE_STYLE}">`,
        `<blockquote style="${QUOTE_STYLE}">`,
        '<p>older</p>',
        '</blockquote>',
        '<p>newer</p>',
        '</blockquote>',
        '<p>mine</p>',
      ].join('\n'),
    );
  });
});

describe('what stays as typed', () => {
  it.each([
    '2 * 3 * 4 = 24',
    '__init__.py and file_name_v2.pdf',
    '*starred* and _under_ and ~tilde~ and ~~two~~',
    'a ** b ** c',
    '***both***',
    '**unclosed and * more',
  ])('a lone star, underscore or tilde: %s', typed => {
    expect(htmlOf(typed)).toBe(`<p>${typed}</p>`);
  });

  it('a star inside bold', () => {
    expect(htmlOf('**5 * 2 today**')).toBe('<p><strong>5 * 2 today</strong></p>');
  });

  it('a heading line, with the lines under it', () => {
    expect(htmlOf('# of attendees: 5')).toBe('<p># of attendees: 5</p>');
    expect(htmlOf('## Agenda ##\nfor Thursday\n- rooms')).toBe(
      '<p>## Agenda ##<br>for Thursday</p>\n<ul>\n<li>rooms</li>\n</ul>',
    );
    expect(htmlOf('> # Quoted\n> text')).toContain('<p># Quoted<br>text</p>');
  });

  it('a table, row by row', () => {
    expect(htmlOf('| a | b |\n|---|---|\n| 1 | 2 |\nafter')).toBe(
      '<p>| a | b |<br>|---|---|<br>| 1 | 2 |</p>\n<p>after</p>',
    );
  });
});

describe('what a mail client would drop', () => {
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

describe('what the marks cannot carry', () => {
  it.each([
    '**[pay](javascript:alert(1))**',
    '# [pay](javascript:alert(1))',
    '| [pay](data:text/html,x) | b |\n|---|---|',
    '> **<script>alert(1)</script>**',
    '> # <img src=x onerror=alert(1)>',
  ])('a script, through bold, a heading line, a table row or a quote: %s', typed => {
    const html = htmlOf(typed);
    expect(html).not.toMatch(/<a |<script|<img|javascript:[^)]*"|onerror="/);
  });
});
