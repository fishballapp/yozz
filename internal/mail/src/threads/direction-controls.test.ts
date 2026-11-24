import { describe, expect, it } from 'vitest';
import { withoutDirectionOverrides } from './direction-controls.ts';

describe('withoutDirectionOverrides', () => {
  it.each([
    ['LRE', '\u202A'],
    ['RLE', '\u202B'],
    ['PDF', '\u202C'],
    ['LRO', '\u202D'],
    ['RLO', '\u202E'],
  ])('removes %s, even where it closes what it opened', (_name, control) => {
    expect(withoutDirectionOverrides(`a${control}b`)).toBe('ab');
  });

  it('turns the extension trick back into what is typed', () => {
    expect(withoutDirectionOverrides('Invoice \u202Efdp.exe\u202C')).toBe('Invoice fdp.exe');
  });

  it.each([
    ['LRM', '\u200E'],
    ['RLM', '\u200F'],
    ['ALM', '\u061C'],
  ])('keeps %s, which a Hebrew or Arabic string needs to set its punctuation', (_name, mark) => {
    expect(withoutDirectionOverrides(`שלום${mark} (תל אביב)`)).toBe(`שלום${mark} (תל אביב)`);
  });

  it.each([
    ['Hebrew name', 'דוד כהן'],
    ['Arabic name', 'محمد الأحمد'],
    ['Arabic subject with an ASCII number', 'فاتورة رقم 4821'],
    ['Hebrew subject with a Latin word', 'Re: פגישה על Stripe מחר'],
    ['Persian with a zero-width non-joiner', 'می\u200Cخواهم'],
    ['a name with no direction at all', 'Ana Ferreira'],
  ])('leaves a %s as it is', (_what, text) => {
    expect(withoutDirectionOverrides(text)).toBe(text);
  });

  it.each([
    ['LRI', '\u2066'],
    ['RLI', '\u2067'],
    ['FSI', '\u2068'],
    ['PDI', '\u2069'],
  ])('removes %s, whether or not it has a partner', (_name, control) => {
    expect(withoutDirectionOverrides(`a${control}b`)).toBe('ab');
  });

  it('removes an isolate pair, so nothing is left to reach what sits beside the text', () => {
    expect(withoutDirectionOverrides('\u2068דוד כהן\u2069 via Group')).toBe('דוד כהן via Group');
    expect(withoutDirectionOverrides('\u2067a \u2066b\u2069 c\u2069')).toBe('a b c');
  });

  it('leaves text with no control at all as the same string', () => {
    expect(withoutDirectionOverrides('')).toBe('');
    expect(withoutDirectionOverrides('Quarterly report')).toBe('Quarterly report');
  });
});
