import { describe, expect, it } from 'vitest';
import { decodeModifiedUtf7, encodeModifiedUtf7 } from './utf7.ts';

describe('modified UTF-7 (RFC 3501 §5.1.3)', () => {
  it('encodes and decodes standard ASCII names and & character', () => {
    expect(encodeModifiedUtf7('INBOX')).toBe('INBOX');
    expect(decodeModifiedUtf7('INBOX')).toBe('INBOX');

    expect(encodeModifiedUtf7('Drafts & Notes')).toBe('Drafts &- Notes');
    expect(decodeModifiedUtf7('Drafts &- Notes')).toBe('Drafts & Notes');

    expect(encodeModifiedUtf7('&&')).toBe('&-&-');
    expect(decodeModifiedUtf7('&-&-')).toBe('&&');
  });

  it('encodes and decodes international Unicode mailbox names', () => {
    const original = 'INBOX/草稿箱';
    const encoded = encodeModifiedUtf7(original);
    expect(decodeModifiedUtf7(encoded)).toBe(original);

    const japanese = 'メール/受信トレイ';
    const encodedJp = encodeModifiedUtf7(japanese);
    expect(decodeModifiedUtf7(encodedJp)).toBe(japanese);
  });
});
