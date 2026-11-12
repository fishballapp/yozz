import { describe, expect, it } from 'vitest';
import {
  buildMessage,
  buildMessageParts,
  encodeAttachmentBody,
  encodeHeaderText,
  formatDate,
  formatMailbox,
  quotedPrintable,
  spliceMessage,
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

  it('writes the ISO calendar whatever the caller passes', () => {
    const hebrew = Temporal.ZonedDateTime.from('2026-08-25T09:42:00[UTC]').withCalendar('hebrew');
    expect(formatDate(hebrew)).toBe('Tue, 25 Aug 2026 09:42:00 +0000');
  });

  it('writes an offset with seconds in whole minutes', () => {
    expect(formatDate(Temporal.ZonedDateTime.from('1900-01-01T00:00:00[Europe/Paris]'))).toBe(
      'Mon, 1 Jan 1900 00:00:00 +0009',
    );
  });

  it('formats an RFC 5322 date', () => {
    expect(formatDate(Temporal.ZonedDateTime.from('2026-08-23T09:05:07[Europe/London]'))).toBe(
      'Sun, 23 Aug 2026 09:05:07 +0100',
    );
    expect(formatDate(Temporal.ZonedDateTime.from('2026-01-05T23:00:00[America/St_Johns]'))).toBe(
      'Mon, 5 Jan 2026 23:00:00 -0330',
    );
  });

  it('produces a 7-bit message with CRLF line endings, text only', () => {
    const raw = decoder.decode(
      buildMessage({
        from: { address: 'me@x.test' },
        to: ['you@y.test', 'them@z.test'],
        subject: 'hi',
        date: Temporal.ZonedDateTime.from('2026-01-01T00:00:00[Europe/London]'),
        messageId: '<id@x.test>',
        text: 'hello\nworld',
      }),
    );
    expect([...raw].every(ch => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(raw.split('\r\n')).toEqual([
      'From: me@x.test',
      'To: you@y.test, them@z.test',
      'Subject: hi',
      'Date: Thu, 1 Jan 2026 00:00:00 +0000',
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
        date: Temporal.Now.zonedDateTimeISO(),
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
        date: Temporal.Now.zonedDateTimeISO(),
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
        date: Temporal.Now.zonedDateTimeISO(),
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

  it('pins the base64 line format, which a frozen message rebuilds from for ever', () => {
    const body = (length: number) =>
      decoder.decode(encodeAttachmentBody(new Uint8Array(length).fill(0xab)));
    expect(body(0)).toBe('');
    expect(body(3)).toBe('q6ur');
    // 57 bytes is exactly one line of 76, and the break after it stays.
    expect(body(57)).toBe(`${'q6ur'.repeat(19)}\r\n`);
    expect(body(58)).toBe(`${'q6ur'.repeat(19)}\r\nqw==`);
  });

  describe('a message with its attachment bodies left out', () => {
    const input = {
      from: { address: 'me@x.test' },
      to: ['you@y.test'],
      subject: 'files',
      date: Temporal.ZonedDateTime.from('2026-11-02T09:00:00[Europe/London]'),
      messageId: '<c@x.test>',
      text: 'see attached',
      html: '<p>see attached</p>',
    };
    const files = [
      { filename: 'a.bin', mimeType: 'application/octet-stream', content: new Uint8Array(100) },
      { filename: '報告.pdf', mimeType: 'application/pdf', content: new Uint8Array([1, 2, 3]) },
    ];
    /** Boundaries are random per build, so two builds compare once those are the same. */
    const withoutBoundaries = (raw: string) => raw.replace(/=_yozz_[0-9a-f-]{36}/g, 'BOUNDARY');

    it('puts back together as the message buildMessage writes', () => {
      const parts = buildMessageParts({ ...input, attachments: files });
      const whole = spliceMessage(
        parts,
        files.map(({ content }) => encodeAttachmentBody(content)),
      );
      expect(withoutBoundaries(decoder.decode(whole))).toBe(
        withoutBoundaries(decoder.decode(buildMessage({ ...input, attachments: files }))),
      );
    });

    it('names each body by a byte offset, not a character one', () => {
      const parts = buildMessageParts({ ...input, to: ['ünï@y.test'], attachments: files });
      expect(parts.splices).toHaveLength(2);
      for (const at of parts.splices) {
        // Each offset falls straight after the blank line that ends a part's headers.
        expect(decoder.decode(parts.head.subarray(at - 4, at))).toBe('\r\n\r\n');
        expect(decoder.decode(parts.head.subarray(0, at))).toMatch(
          /Content-Transfer-Encoding: base64\r\n\r\n$/,
        );
      }
    });

    it('holds the whole message, with no splices, when there are no attachments', () => {
      const parts = buildMessageParts(input);
      expect(parts.splices).toEqual([]);
      expect(withoutBoundaries(decoder.decode(parts.head))).toBe(
        withoutBoundaries(decoder.decode(buildMessage(input))),
      );
    });
  });

  it('names carbon copies in a Cc header and blind ones nowhere at all', () => {
    const base = {
      from: { address: 'me@x.test' },
      to: ['you@y.test'],
      subject: 's',
      date: Temporal.ZonedDateTime.from('2026-08-25T09:00:00[Europe/London]'),
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
        date: Temporal.Now.zonedDateTimeISO(),
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
      date: Temporal.ZonedDateTime.from('2026-08-25T10:00:00[UTC]'),
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
    date: Temporal.ZonedDateTime.from('2026-08-28T09:00:00[UTC]'),
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
