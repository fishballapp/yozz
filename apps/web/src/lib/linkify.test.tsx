import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';
import { linkify } from './linkify';

const anchors = (text: string) =>
  (linkify(text) as unknown[]).filter(node => isValidElement(node)).length;

describe('linkify', () => {
  it('links a bare URL and an address', () => {
    expect(anchors('see https://example.com. or mail hi@yozz.app')).toBe(2);
  });

  it('leaves a URL with userinfo as prose', () => {
    expect(anchors('https://www.google.com@evil.com/login')).toBe(0);
    expect(anchors('www.google.com@evil.com')).toBe(0);
  });

  it('leaves YOZZ application origins as prose', () => {
    expect(anchors('https://yozz.app/settings')).toBe(0);
    expect(anchors('https://api.yozz.app/api/v1/vault/delete')).toBe(0);
    expect(anchors('https://yozz.app./settings')).toBe(0);
  });
});
