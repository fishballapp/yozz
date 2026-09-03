// @vitest-environment jsdom
import { renderHtml } from '@tanstack/markdown/html';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownView } from './MarkdownView';

describe('MarkdownView links', () => {
  it('previews the same explicit links that renderHtml sends', () => {
    const source =
      '[app](https://yozz.app/settings) [top](#top) [docs](/guide) [external](https://example.com/pay) [unsafe](javascript:alert(1)) bare https://example.net';
    const preview = new DOMParser().parseFromString(
      renderToStaticMarkup(<MarkdownView source={source} />),
      'text/html',
    );
    const sent = new DOMParser().parseFromString(renderHtml(source), 'text/html');
    const hrefsOf = (document: Document) =>
      Array.from(document.querySelectorAll('a'), link => link.getAttribute('href'));
    expect(hrefsOf(preview)).toEqual(hrefsOf(sent));
    expect(hrefsOf(preview)).toEqual([
      'https://yozz.app/settings',
      '#top',
      '/guide',
      'https://example.com/pay',
    ]);
    expect(preview.body.textContent).toContain('unsafe');
    expect(preview.body.textContent).toContain('bare https://example.net');
  });
});
