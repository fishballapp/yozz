import { describe, expect, it } from 'vitest';
import { nameHoldsAnAddress, senderLabelOf } from './sender-name.ts';

const SCAM = 'scam@evil.top';
/** The row's label for a name from `scam@evil.top`: the name, or the address. */
const labelOf = (fromName: string, fromAddress = SCAM) => senderLabelOf({ fromName, fromAddress });

describe('senderLabelOf', () => {
  it.each([
    ['an ordinary name', 'Jane Ferreira'],
    ['one word', 'Stripe'],
    ['a name with a dot and brackets', 'Jane (jane.doe)'],
    ['a name in Hebrew', 'דוד כהן'],
    ['a name in Arabic', 'محمد الأحمد'],
    ['a name with a version in it', 'Release v2.0'],
    ['a name with a time in it', 'Standup 10.30'],
    ['a name with a hyphen and a dot', 'Node.js - Team'],
  ])('is the name for %s', (_what, name) => {
    expect(labelOf(name)).toBe(name);
  });

  it('is the name when there is none to speak of, and the address when there is no name', () => {
    expect(labelOf('')).toBe('');
    expect(labelOf('', 'ada@example.com')).toBe('');
  });

  it.each([
    ['an address', 'billing@stripe.com'],
    ['an address in quotes', '"billing@stripe.com"'],
    ['an address with text around it', 'Stripe Billing <billing@stripe.com>'],
    ['a handle', 'Alice @acme'],
    ['a handle in brackets', 'Jane (@jane.doe)'],
    ['a platform handle', 'Team @Node.js'],
    ['a bare @', 'a @ b'],
    ['another hyphen', 'billing@my\u2010stripe.com'],
    ['a hair space', 'billing@\u200Astripe.com'],
    ['an unassigned default-ignorable', 'billing@str\u2065ipe.com'],
    ['a joiner', 'billing@str\u034Fipe.com'],
    ['a variation selector', 'billing@str\uFE0Eipe.com'],
    ['a zero-width space', 'billing@str\u200Bipe.com'],
    ['an ideographic full stop', 'billing@stripe\u3002com'],
    ['a full-width @', 'billing\uFF20stripe.com'],
    ['a small @', 'billing\uFE6Bstripe.com'],
    ['an address of the sender’s own organisation', 'help@paypal.com.billing.example.net'],
    ['an address long enough to be cut by the cell', `${'a'.repeat(60)}@stripe.com`],
  ])('is the address for %s', (_what, name) => {
    expect(labelOf(name)).toBe(SCAM);
  });

  it('keeps the name of a message with no From address to show instead', () => {
    expect(labelOf('me@example.com', '')).toBe('me@example.com');
  });

  it('is the address for the sender’s own address, which is the same thing', () => {
    expect(labelOf('ada@example.com', 'ada@example.com')).toBe('ada@example.com');
  });

  describe('a mailing list’s rewrite of the sender', () => {
    it.each([
      "'alice@gmail.com' via Some Group",
      '"alice@gmail.com" via Some Group',
      'alice@gmail.com via Some Group',
      "'alice+news@mail.example.co.uk' via 7 Dwarves",
    ])('is the name: %s', name => {
      expect(labelOf(name, 'group@lists.example.org')).toBe(name);
    });

    it.each([
      ['padded with spaces', `'billing@stripe.com'${' '.repeat(40)}via x`],
      ['padded with a hair space', "'billing@stripe.com'\u200Avia x"],
      ['padded with no-break spaces', "'billing@stripe.com'\u00A0\u00A0via x"],
      ['padded with ideographic spaces', "'billing@stripe.com'\u3000\u3000via x"],
      ['padded with a braille blank', `'billing@stripe.com'${'\u2800'.repeat(40)} via x`],
      ['padded with a Hangul filler', `'billing@stripe.com'${'\u3164'.repeat(40)} via x`],
      [
        'padded with a Mongolian vowel separator',
        `'billing@stripe.com'${'\u180E'.repeat(40)} via x`,
      ],
      ['padded with a zero-width space', "'billing@stripe.com'\u200B via x"],
      ['padded before the address', " 'billing@stripe.com' via x"],
      ['with a blank after via', "'billing@stripe.com' via \u2800"],
      ['with a Hangul filler after via', "'billing@stripe.com' via \u3164x"],
      ['with nothing after via', "'billing@stripe.com' via "],
      ['with a space after via, then a name', "'billing@stripe.com' via  x"],
      ['with a name in another script', "'billing@stripe.com' via דוד"],
      ['with a second address after via', "'alice@gmail.com' via billing@stripe.com"],
      ['with a second address further on', "'alice@gmail.com' via Some Group <billing@stripe.com>"],
      ['with a full-width @ after via', "'alice@gmail.com' via Some Group \uFF20stripe"],
      ['with a small @ after via', "'alice@gmail.com' via Some Group \uFE6Bstripe"],
      ['with quotes unmatched', "'alice@gmail.com via Some Group"],
      ['with an invisible mark in the address', "'alice@gm\u034Fail.com' via Some Group"],
      ['with a hyphen of another kind in the address', "'alice@my\u2010mail.com' via Some Group"],
      ['with a space inside the address', "'alice @gmail.com' via Some Group"],
      ['with a text before the address', 'From alice@gmail.com via Some Group'],
      ['in upper case', "'alice@gmail.com' VIA Some Group"],
    ])('is the address when %s', (_what, name) => {
      expect(labelOf(name, 'group@lists.example.org')).toBe('group@lists.example.org');
    });
  });

  it('is linear in the length of the name, whatever it is made of', () => {
    const n = 30_000;
    const names = [
      'a'.repeat(n),
      `${'a'.repeat(n)}@${'b'.repeat(n)}`,
      'a@'.repeat(n / 2),
      `'${'a'.repeat(n)}@${'b.'.repeat(n / 2)} via x`,
      `'${'a.'.repeat(n / 2)}@b`,
      "'".repeat(n),
      ' '.repeat(n),
      `'a@b' via ${' '.repeat(n)}`,
      '\u0300'.repeat(n),
    ];
    for (const name of names) {
      const start = performance.now();
      labelOf(name);
      expect(performance.now() - start).toBeLessThan(250);
    }
  });
});

describe('nameHoldsAnAddress', () => {
  it('is whether the name holds an @, bar the list’s rewrite', () => {
    expect(nameHoldsAnAddress('Jane Ferreira')).toBe(false);
    expect(nameHoldsAnAddress('billing@stripe.com')).toBe(true);
    expect(nameHoldsAnAddress("'alice@gmail.com' via Some Group")).toBe(false);
  });
});
