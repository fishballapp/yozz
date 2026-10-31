import { describe, expect, it } from 'vitest';
import {
  byteString,
  bytesOf,
  canonicalBody,
  canonicalHeader,
  splitMessage,
} from './dkim-canonical.ts';

const ascii = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** `splitMessage` of a block that must be clean. */
const split = (raw: string | Uint8Array) => {
  const message = splitMessage(typeof raw === 'string' ? ascii(raw) : raw);
  if (message === null) throw new Error('the header block should be clean');
  return message;
};

// RFC 6376 §3.4.5, the specification's own example, written out byte for byte.
const RFC_EXAMPLE = 'A: X\r\nB : Y\t\r\n\tZ  \r\n\r\n C \r\nD \t E\r\n\r\n\r\n';

describe('splitMessage', () => {
  it('splits fields at unfolded line starts and keeps folds inside the field', () => {
    const { headers, body } = split(RFC_EXAMPLE);
    expect(headers).toEqual([
      { name: 'a', raw: 'A: X' },
      { name: 'b', raw: 'B : Y\t\r\n\tZ  ' },
    ]);
    expect(text(body)).toBe(' C \r\nD \t E\r\n\r\n\r\n');
  });

  it('reads bare LF line ends as CRLF', () => {
    const { headers, body } = split('From: a@b.example\nSubject: hi\n there\n\nbody\n');
    expect(headers.map(header => header.raw)).toEqual([
      'From: a@b.example',
      'Subject: hi\r\n there',
    ]);
    expect(text(body)).toBe('body\n');
  });

  it('treats a message with no empty line as headers only', () => {
    const { headers, body } = split('From: a@b.example\r\nTo: c@d.example');
    expect(headers).toHaveLength(2);
    expect(body).toHaveLength(0);
  });

  it('refuses a block another parser could read differently', () => {
    const unclean = [
      // A CR CR LF line ends postal-mime's headers here; ours would run on into the next ones.
      'X-Mailer: x\r\n\r\r\nX-A: <b>evil</b><!--\r\nFrom: a@b.example\r\n\r\n',
      'Subject: a\rb\r\nFrom: a@b.example\r\n\r\n',
      // A first line that opens with WSP: dropped by a strict reader, a From to postal-mime.
      ' From: ceo@victim.example\r\nFrom: a@b.example\r\n\r\n',
      // A name folded before its colon.
      'From\r\n : ceo@victim.example\r\n\r\n',
      'not a header\r\nFrom: a@b.example\r\n\r\n',
      ': no name\r\n\r\n',
    ];
    for (const block of unclean) expect(splitMessage(ascii(block))).toBeNull();
  });

  it('reads a long whitespace run before a colon in linear time', () => {
    const started = performance.now();
    expect(splitMessage(ascii(`From${' '.repeat(200_000)}x: a\r\n\r\n`))).toBeNull();
    expect(split(`From${' '.repeat(200_000)}: a\r\n\r\n`).headers[0]?.name).toBe('from');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps 8-bit header bytes as they are', () => {
    const raw = new Uint8Array([
      ...ascii('Subject: '),
      0xc3,
      0xa9,
      0x85,
      0xa0,
      ...ascii('\r\n\r\n'),
    ]);
    const [subject] = split(raw).headers;
    expect(subject && bytesOf(subject.raw)).toEqual(raw.subarray(0, 13));
  });
});

describe('canonicalHeader', () => {
  const [a, b] = split(RFC_EXAMPLE).headers;
  if (a === undefined || b === undefined) throw new Error('the example has two fields');

  it('relaxed: the RFC example', () => {
    expect(canonicalHeader(a, 'relaxed') + canonicalHeader(b, 'relaxed')).toBe('a:X\r\nb:Y Z\r\n');
  });

  it('simple: the RFC example, unchanged', () => {
    expect(canonicalHeader(a, 'simple') + canonicalHeader(b, 'simple')).toBe(
      'A: X\r\nB : Y\t\r\n\tZ  \r\n',
    );
  });

  it('relaxed trims only SP and HTAB, never the 0x85 or 0xA0 bytes of a value', () => {
    const field = { name: 'subject', raw: `Subject:  x\u0085 ` };
    expect(canonicalHeader(field, 'relaxed')).toBe('subject: x\u0085\r\n');
  });

  it('relaxed keeps the value’s case', () => {
    expect(canonicalHeader({ name: 'subject', raw: 'SUBJECT: Hello World' }, 'relaxed')).toBe(
      'subject:Hello World\r\n',
    );
  });
});

describe('canonicalBody', () => {
  const { body } = split(RFC_EXAMPLE);

  it('relaxed: the RFC example', () => {
    expect(text(canonicalBody(body, 'relaxed'))).toBe(' C\r\nD E\r\n');
  });

  it('simple: the RFC example', () => {
    expect(text(canonicalBody(body, 'simple'))).toBe(' C \r\nD \t E\r\n');
  });

  it('an empty body is one CRLF in simple and nothing in relaxed', () => {
    for (const empty of ['', '\r\n', '\r\n\r\n']) {
      expect(text(canonicalBody(ascii(empty), 'simple'))).toBe('\r\n');
      expect(text(canonicalBody(ascii(empty), 'relaxed'))).toBe('');
    }
  });

  it('relaxed treats a line of whitespace as empty', () => {
    expect(text(canonicalBody(ascii('a\r\n \t\r\n  \r\n'), 'relaxed'))).toBe('a\r\n');
    expect(text(canonicalBody(ascii('a\r\n \t\r\nb'), 'relaxed'))).toBe('a\r\n\r\nb\r\n');
  });

  it('ends an unterminated last line with CRLF', () => {
    expect(text(canonicalBody(ascii('a\r\nb'), 'simple'))).toBe('a\r\nb\r\n');
    expect(text(canonicalBody(ascii('a\r\nb  '), 'relaxed'))).toBe('a\r\nb\r\n');
  });

  it('makes bare LF line ends CRLF and keeps a lone CR', () => {
    expect(text(canonicalBody(ascii('a\nb\rc\n\n'), 'simple'))).toBe('a\r\nb\rc\r\n');
  });

  it('keeps empty lines between content', () => {
    expect(text(canonicalBody(ascii('a\r\n\r\n\r\nb\r\n'), 'simple'))).toBe('a\r\n\r\n\r\nb\r\n');
  });

  it('walks a multi-megabyte body', () => {
    const line = 'The quick brown fox  jumps over the lazy dog.   \r\n';
    const big = ascii(line.repeat(100_000));
    expect(canonicalBody(big, 'relaxed')).toHaveLength(
      'The quick brown fox jumps over the lazy dog.\r\n'.length * 100_000,
    );
    expect(canonicalBody(big, 'simple')).toHaveLength(big.length);
  });
});

describe('byteString', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(bytesOf(byteString(all))).toEqual(all);
  });
});
