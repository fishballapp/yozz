// @vitest-environment jsdom
import { renderHtml } from '@tanstack/markdown/html';
import { MAIL_MARKDOWN } from '@yozz.app/mail/compose/markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView';

const previewOf = (source: string) =>
  new DOMParser().parseFromString(
    renderToStaticMarkup(<MarkdownView source={source} />),
    'text/html',
  );
const sentOf = (source: string) =>
  new DOMParser().parseFromString(renderHtml(source, MAIL_MARKDOWN), 'text/html');

describe('MarkdownView', () => {
  it('previews the same links that are sent', () => {
    const source =
      '[app](https://yozz.app/settings) [top](#top) [docs](/guide) [external](https://example.com/pay) [unsafe](javascript:alert(1)) bare https://example.net';
    const preview = previewOf(source);
    const hrefsOf = (document: Document) =>
      Array.from(document.querySelectorAll('a'), link => link.getAttribute('href'));
    expect(hrefsOf(preview)).toEqual(hrefsOf(sentOf(source)));
    expect(hrefsOf(preview)).toEqual([
      'https://yozz.app/settings',
      '#top',
      '/guide',
      'https://example.com/pay',
      'https://example.net',
    ]);
    expect(preview.body.textContent).toContain('unsafe');
  });

  it('previews the same elements, in the same order, that are sent', () => {
    const source = [
      '# Invoice',
      'Thanks,\nJason',
      '> 12 Mill Lane\n> Leeds',
      '- [ ] book\n- [x] pay',
      'Paid[^a] at https://example.com.',
      '[^a]: On 3 May.',
    ].join('\n\n');
    // The preview wraps its body in one styled div, which the message has none of.
    const tagsOf = (root: Element) =>
      Array.from(root.querySelectorAll('*'), ({ tagName }) => tagName);
    const preview = previewOf(source).body.firstElementChild;
    if (preview === null) throw new Error('the preview rendered nothing');
    expect(tagsOf(preview)).toEqual(tagsOf(sentOf(source).body));
    expect(preview.textContent?.replace(/\s+/g, '')).toBe(
      sentOf(source).body.textContent?.replace(/\s+/g, ''),
    );
    expect(tagsOf(preview)).toContain('BR');
    expect(preview.querySelector('input, [id]')).toBeNull();
  });
});
