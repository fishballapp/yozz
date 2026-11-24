import type { Message } from '@yozz.app/mail/threads/thread';
import { describe, expect, it } from 'vitest';
import { fromOf, LINE_CHARS, untrusted } from './rows.ts';

describe('untrusted', () => {
  it('removes what reorders the text around it, wherever the string came from', () => {
    expect(untrusted('Invoice \u202Efdp.exe\u202C')).toBe('Invoice fdp.exe');
    expect(untrusted('a\u2066b\u2069c')).toBe('abc');
  });

  it('removes the terminal’s controls, keeping lines and tabs', () => {
    expect(untrusted('a\u001B[2Jb\u0007c\u0085d\u007Fe\nf\tg')).toBe('a[2Jbcde\nf\tg');
  });

  it('keeps the marks a Hebrew or Arabic string needs', () => {
    expect(untrusted('שלום\u200F (עולם)')).toBe('שלום\u200F (עולם)');
    expect(untrusted('محمد\u061C ١٢٣')).toBe('محمد\u061C ١٢٣');
  });
});

describe('fromOf', () => {
  const from = (fromName: string, fromAddress: string) =>
    fromOf({ fromName, fromAddress } as Message);

  it('writes name and address together, or the address alone', () => {
    expect(from('Ada', 'ada@example.com')).toBe('Ada <ada@example.com>');
    expect(from('', 'ada@example.com')).toBe('ada@example.com');
    expect(from('ada@example.com', 'ada@example.com')).toBe('ada@example.com');
  });

  it('keeps the address whole when the name fills the line, and cuts the name', () => {
    const name = `billing@stripe.com ${'x'.repeat(5_000)}`;
    const shown = from(name, 'scam@evil.top');
    expect(shown.endsWith(' <scam@evil.top>')).toBe(true);
    expect(shown.startsWith('billing@stripe.com')).toBe(true);
    expect(shown.length).toBeLessThan(LINE_CHARS + 60);
  });

  it('writes the address alone, with no marker for the name, when it leaves no room', () => {
    const address = `${'a'.repeat(LINE_CHARS - 10)}@evil.top`;
    expect(from('Ada Ferreira', address)).toBe(address);
    expect(from('Ada Ferreira', address)).not.toContain('truncated');
  });

  it('keeps the address when the name is a few characters short of the line', () => {
    const address = 'scam@evil.top';
    const shown = from('n'.repeat(LINE_CHARS - 5), address);
    expect(shown.endsWith(` <${address}>`)).toBe(true);
  });
});
