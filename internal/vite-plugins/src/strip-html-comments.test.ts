import { describe, expect, it } from 'vitest';
import { withoutHtmlComments } from './strip-html-comments';

describe('withoutHtmlComments', () => {
  it('removes every comment, including multi-line ones and their leading whitespace', () => {
    expect(
      withoutHtmlComments(
        '<head>\n    <!-- a\n    b -->\n    <meta charset="utf-8" />\n  </head>\n  <body>\n    <!-- c --><div id="root"></div></body>',
      ),
    ).toBe('<head>\n    <meta charset="utf-8" />\n  </head>\n  <body><div id="root"></div></body>');
  });
});
