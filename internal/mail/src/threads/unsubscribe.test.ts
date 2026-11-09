import { describe, expect, it } from 'vitest';
import { parseBody } from './bodies.ts';
import { MAX_URI_CHARS, mailtoDraftOf, unsubscribeOf } from './unsubscribe.ts';

describe('unsubscribeOf', () => {
  it('reads both forms of a comma-separated list', () => {
    expect(
      unsubscribeOf('<https://example.com/u?id=1>, <mailto:unsub@example.com?subject=unsubscribe>'),
    ).toEqual({
      https: 'https://example.com/u?id=1',
      mailto: 'mailto:unsub@example.com?subject=unsubscribe',
    });
  });

  it('keeps the first of each form', () => {
    expect(
      unsubscribeOf(
        '<mailto:a@x.test>, <https://one.test/>, <https://two.test/>, <mailto:b@x.test>',
      ),
    ).toEqual({ https: 'https://one.test/', mailto: 'mailto:a@x.test' });
  });

  it('ignores http: and every other scheme', () => {
    expect(unsubscribeOf('<http://example.com/u>')).toBeNull();
    expect(unsubscribeOf('<ftp://example.com/u>, <javascript:alert(1)>, <tel:+1555>')).toBeNull();
    expect(unsubscribeOf('<http://example.com/u>, <https://example.com/ok>')).toEqual({
      https: 'https://example.com/ok',
    });
  });

  it('reads one form when only one is offered', () => {
    expect(unsubscribeOf('<https://example.com/u>')).toEqual({ https: 'https://example.com/u' });
    expect(unsubscribeOf('<mailto:u@example.com>')).toEqual({ mailto: 'mailto:u@example.com' });
  });

  it('tolerates whitespace inside the brackets and around the commas', () => {
    expect(unsubscribeOf('  < https://example.com/u >  ,\t<mailto:u@example.com>')).toEqual({
      https: 'https://example.com/u',
      mailto: 'mailto:u@example.com',
    });
  });

  it('offers nothing for an absent, empty or malformed header', () => {
    for (const header of [
      undefined,
      '',
      'https://example.com/u',
      '<>',
      '<https://example.com/u',
      '<https://>',
      '<https:///path>',
      '<mailto:>',
      '<mailto:no-at-sign>',
      '<mailto:%E0%A4%A@x.test>',
      'garbage, <, >, <<>>',
    ]) {
      expect(unsubscribeOf(header)).toBeNull();
    }
  });

  it('joins a URI folded across lines, where whitespace is no part of it', () => {
    expect(unsubscribeOf('<https://example.com/un subscribe/\r\n abc>')).toEqual({
      https: 'https://example.com/unsubscribe/abc',
    });
  });

  it('skips a URI longer than any link worth following', () => {
    const long = `https://example.com/${'a'.repeat(MAX_URI_CHARS)}`;
    expect(unsubscribeOf(`<${long}>, <mailto:u@example.com>`)).toEqual({
      mailto: 'mailto:u@example.com',
    });
  });

  it('does not offer a mailto: that names no one over a later one that does', () => {
    expect(unsubscribeOf('<mailto:?subject=x>, <mailto:u@example.com>')).toEqual({
      mailto: 'mailto:u@example.com',
    });
  });
});

describe('mailtoDraftOf', () => {
  it('reads the address, subject and body', () => {
    expect(
      mailtoDraftOf('mailto:u@example.com?subject=Unsubscribe&body=Remove%20me%0D%0Athanks'),
    ).toEqual({ to: 'u@example.com', subject: 'Unsubscribe', body: 'Remove me\nthanks' });
  });

  it('keeps a plus as a plus, which a form would turn into a space', () => {
    expect(mailtoDraftOf('mailto:u+list@example.com?subject=a+b')).toEqual({
      to: 'u+list@example.com',
      subject: 'a+b',
    });
  });

  it('takes the first of a repeated field and ignores cc and bcc', () => {
    expect(
      mailtoDraftOf('mailto:u@example.com?subject=one&subject=two&cc=x@y.test&bcc=z@y.test'),
    ).toEqual({
      to: 'u@example.com',
      subject: 'one',
    });
  });

  it('decodes an address and keeps a subject on one line', () => {
    expect(mailtoDraftOf('mailto:u%40example.com?subject=a%0Ab')).toEqual({
      to: 'u@example.com',
      subject: 'a b',
    });
  });

  it('is total: a field that does not decode is left out, not thrown', () => {
    expect(mailtoDraftOf('mailto:u@example.com?subject=%E0%A4%A&body=ok')).toEqual({
      to: 'u@example.com',
      body: 'ok',
    });
  });

  it('is not a draft for another scheme or for no address', () => {
    expect(mailtoDraftOf('https://example.com')).toBeNull();
    expect(mailtoDraftOf('mailto:')).toBeNull();
    expect(mailtoDraftOf('mailto:?subject=x')).toBeNull();
    expect(mailtoDraftOf('mailto:a b@example.com')).toBeNull();
  });
});

const raw = (text: string) => new TextEncoder().encode(text.replace(/\n/g, '\r\n'));
const parse = async (headers: string) =>
  (await parseBody(raw(`${headers}\nSubject: hi\n\nBody.\n`), async () => [])).body.unsubscribe;

describe('parseBody — List-Unsubscribe', () => {
  it('reads the header of an opened message', async () => {
    expect(
      await parse(
        'List-Unsubscribe: <https://example.com/u?id=1>, <mailto:unsub@example.com?subject=unsubscribe>',
      ),
    ).toEqual({
      https: 'https://example.com/u?id=1',
      mailto: 'mailto:unsub@example.com?subject=unsubscribe',
    });
  });

  it('reads a header folded over several lines', async () => {
    expect(
      await parse(
        'List-Unsubscribe: <https://example.com/unsubscribe/a-very-long-path>,\n <mailto:unsub@example.com\n ?subject=unsubscribe>',
      ),
    ).toEqual({
      https: 'https://example.com/unsubscribe/a-very-long-path',
      mailto: 'mailto:unsub@example.com?subject=unsubscribe',
    });
  });

  it('is null for a message without the header or with only http:', async () => {
    expect(await parse('From: a@example.com')).toBeNull();
    expect(await parse('List-Unsubscribe: <http://example.com/u>')).toBeNull();
  });

  it('reads the header whatever its case, and the first of a repeated one', async () => {
    expect(
      await parse('list-unsubscribe: <https://one.test/>\nLIST-UNSUBSCRIBE: <https://two.test/>'),
    ).toEqual({ https: 'https://one.test/' });
  });
});
