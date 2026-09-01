import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  encodeHeaderText,
  formatDate,
  formatMailbox,
  quotedPrintable,
} from './message.ts';

const decoder = new TextDecoder();

describe('message builder', () => {
  it('keeps ASCII headers plain and encodes the rest', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject');
    expect(encodeHeaderText('Café ☕')).toBe(
      `=?utf-8?B?${btoa(unescape(encodeURIComponent('Café ☕')))}?=`,
    );
    expect(formatMailbox({ address: 'a@x' })).toBe('a@x');
    expect(formatMailbox({ address: 'a@x', name: 'Ann Lee' })).toBe('Ann Lee <a@x>');
    expect(formatMailbox({ address: 'a@x', name: 'Lee, Ann' })).toBe('"Lee, Ann" <a@x>');
    expect(formatMailbox({ address: 'a@x', name: 'Zoë' })).toMatch(/^=\?utf-8\?B\?.*\?= <a@x>$/);
  });

  it('splits long non-ASCII text into legal encoded-words and folds long ASCII', () => {
    const subject = '郵'.repeat(40);
    const encoded = encodeHeaderText(subject);
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    }
    const decoded = words
      .map(word => decodeURIComponent(escape(atob(word.slice(10, -2)))))
      .join('');
    expect(decoded).toBe(subject);

    const longAscii = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const folded = encodeHeaderText(longAscii);
    expect(folded.split('\r\n ').every(line => line.length <= 78)).toBe(true);
    expect(folded.replace(/\r\n /g, ' ')).toBe(longAscii);
  });

  it('formats an RFC 5322 date', () => {
    expect(formatDate(new Date(2026, 7, 23, 9, 5, 7))).toMatch(
      /^Sun, 23 Aug 2026 09:05:07 [+-]\d{4}$/,
    );
  });

  it('produces a 7-bit message with CRLF line endings, text only', () => {
    const raw = decoder.decode(
      buildMessage({
        from: { address: 'me@x.test' },
        to: ['you@y.test', 'them@z.test'],
        subject: 'hi',
        date: new Date(2026, 0, 1),
        messageId: '<id@x.test>',
        text: 'hello\nworld',
      }),
    );
    expect([...raw].every(ch => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(raw.split('\r\n')).toEqual([
      'From: me@x.test',
      'To: you@y.test, them@z.test',
      'Subject: hi',
      expect.stringMatching(/^Date: /),
      'Message-ID: <id@x.test>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      'hello',
      'world',
      '',
    ]);
  });

  it('quoted-printable: escapes, protects trailing space, soft-wraps without splitting an escape', () => {
    expect(quotedPrintable('a=b \nCafé')).toBe('a=3Db=20\r\nCaf=C3=A9');
    const long = `${'x'.repeat(74)}é`;
    const encoded = quotedPrintable(long);
    expect(encoded.split('\r\n').every(line => line.length <= 76)).toBe(true);
    expect(encoded).toMatch(/=\r\n/);
    expect(encoded.replace(/=\r\n/g, '')).toBe(`${'x'.repeat(74)}=C3=A9`);
    const raw = decoder.decode(
      buildMessage({
        from: { address: 'me@x.test' },
        to: ['you@y.test'],
        subject: 's',
        date: new Date(),
        messageId: '<i@x>',
        text: 'Café',
      }),
    );
    expect(raw).toContain('Content-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9\r\n');
  });

  it('wraps a text + html pair in multipart/alternative and threads a reply', () => {
    const raw = decoder.decode(
      buildMessage({
        from: { address: 'me@x.test', name: 'Me' },
        to: ['you@y.test'],
        subject: 'Re: hi',
        date: new Date(),
        messageId: '<b@x.test>',
        inReplyTo: '<a@y.test>',
        text: '**bold**',
        html: '<p><strong>bold</strong></p>',
      }),
    );
    expect(raw).toContain('In-Reply-To: <a@y.test>\r\nReferences: <a@y.test>\r\n');
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
    expect(boundary).toBeDefined();
    expect(raw.split(`--${boundary}`)).toHaveLength(4);
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    expect(raw.endsWith(`--${boundary}--\r\n`)).toBe(true);
  });

  it('wraps body and files in multipart/mixed with base64 lines of 76 and RFC 2231 names', () => {
    const raw = decoder.decode(
      buildMessage({
        from: { address: 'me@x.test' },
        to: ['you@y.test'],
        subject: 'files',
        date: new Date(),
        messageId: '<c@x.test>',
        text: 'see attached',
        html: '<p>see attached</p>',
        attachments: [
          {
            filename: 'a "b".bin',
            mimeType: 'application/octet-stream',
            content: new Uint8Array(100),
          },
          {
            filename: "報告 (d'été)*.pdf",
            mimeType: 'application/pdf',
            content: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    );
    const mixed = /multipart\/mixed; boundary="([^"]+)"/.exec(raw)?.[1];
    const alternative = /multipart\/alternative; boundary="([^"]+)"/.exec(raw)?.[1];
    expect(mixed).toBeDefined();
    expect(alternative).toBeDefined();
    expect(raw.split(`--${mixed}`)).toHaveLength(5);
    expect(raw.indexOf(`--${alternative}`)).toBeGreaterThan(raw.indexOf(`--${mixed}`));
    expect(raw).toContain('Content-Disposition: attachment; filename="a \\"b\\".bin"');
    expect(raw).toContain(
      "Content-Disposition: attachment; filename*=utf-8''%E5%A0%B1%E5%91%8A%20%28d%27%C3%A9t%C3%A9%29%2A.pdf",
    );
    expect(raw).toContain('Content-Transfer-Encoding: base64\r\n\r\nAQID\r\n');
    const base64Block = raw
      .split('Content-Transfer-Encoding: base64\r\n\r\n')[1]
      ?.split('\r\n--')[0];
    expect(base64Block?.split('\r\n').every(line => line.length <= 76)).toBe(true);
    expect(base64Block?.replace(/\r\n/g, '')).toBe(
      btoa(String.fromCharCode(...new Uint8Array(100))),
    );
    expect(raw.endsWith(`--${mixed}--\r\n`)).toBe(true);
  });

  it('names carbon copies in a Cc header and blind ones nowhere at all', () => {
    const base = {
      from: { address: 'me@x.test' },
      to: ['you@y.test'],
      subject: 's',
      date: new Date(2026, 7, 25, 9, 0, 0),
      messageId: '<i@x>',
      text: 'body',
    };
    const withCc = decoder.decode(
      buildMessage({ ...base, cc: ['one@y.test', 'two@y.test', 'three@y.test'] }),
    );
    expect(withCc).toContain('\r\nCc: one@y.test, two@y.test, three@y.test\r\n');
    expect(withCc.indexOf('\r\nCc:')).toBeLessThan(withCc.indexOf('\r\nSubject:'));

    expect(decoder.decode(buildMessage(base))).not.toContain('Cc:');
    expect(decoder.decode(buildMessage({ ...base, cc: [] }))).not.toContain('Cc:');

    for (const bytes of [buildMessage(base), buildMessage({ ...base, cc: ['one@y.test'] })])
      expect(decoder.decode(bytes).toLowerCase()).not.toContain('bcc:');
  });

  it('refuses a header that carries a line break', () => {
    expect(() =>
      buildMessage({
        from: { address: 'me@x.test' },
        to: ['you@y.test\r\nBcc: spy@z.test'],
        subject: 's',
        date: new Date(),
        messageId: '<i@x>',
        text: '',
      }),
    ).toThrow('To contains a line break');
  });
});

describe('a message with nobody in To', () => {
  it('omits the To header instead of emitting an empty one', () => {
    const bytes = buildMessage({
      from: { address: 'me@example.com' },
      to: [],
      cc: ['cc@example.com'],
      subject: 'copy only',
      date: new Date('2026-08-25T10:00:00Z'),
      messageId: '<1@example.com>',
      text: 'hi',
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toMatch(/^To:/m);
    expect(text).toMatch(/^Cc: cc@example.com\r?$/m);
  });
});

describe('References', () => {
  const base = {
    from: { address: 'me@example.com' },
    to: ['you@example.com'],
    subject: 'Re: hi',
    date: new Date(Date.UTC(2026, 7, 28, 9, 0, 0)),
    messageId: '<new@example.com>',
    text: 'body',
  };
  const headersOf = (input: Parameters<typeof buildMessage>[0]) =>
    new TextDecoder().decode(buildMessage(input)).split('\r\n\r\n')[0] ?? '';

  it('carries the whole chain, oldest first, folded so no line runs long', () => {
    const chain = Array.from({ length: 12 }, (_, index) => `<m${index}@example.com>`);
    const headers = headersOf({ ...base, inReplyTo: '<m11@example.com>', references: chain });
    expect(headers).toContain('In-Reply-To: <m11@example.com>');
    const references = headers
      .split('\r\n')
      .join('\n')
      .replace(/\n[ \t]+/g, ' ')
      .split('\n')
      .find(line => line.startsWith('References:'));
    expect(references).toBe(`References: ${chain.join(' ')}`);
    for (const line of headers.split('\r\n')) expect(line.length).toBeLessThan(998);
  });

  it('falls back to the parent alone, which is what a first reply references', () => {
    expect(headersOf({ ...base, inReplyTo: '<parent@example.com>' })).toContain(
      'References: <parent@example.com>',
    );
  });

  it('writes no References on a message that answers nothing', () => {
    expect(headersOf(base)).not.toContain('References:');
  });
});
