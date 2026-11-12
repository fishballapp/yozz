import { describe, expect, it } from 'vitest';
import { asciiToString } from './bytes.ts';
import {
  buildAppendCommand,
  buildUidExpungeCommand,
  buildUidSearchCommand,
  formatImapDateTime,
  type UidSearchCriteria,
} from './commands.ts';

describe('formatImapDateTime', () => {
  it("space-pads the day and names the month, in the date's own zone", () => {
    expect(
      formatImapDateTime(Temporal.ZonedDateTime.from('2026-08-08T09:48:03[Europe/London]')),
    ).toBe('" 8-Aug-2026 09:48:03 +0100"');
    expect(
      formatImapDateTime(Temporal.ZonedDateTime.from('2026-12-25T23:05:00[America/St_Johns]')),
    ).toBe('"25-Dec-2026 23:05:00 -0330"');
  });
});

describe('formatImapDateTime, from a caller in another calendar or an old zone', () => {
  it('writes the ISO calendar whatever the caller passes', () => {
    const hebrew = Temporal.ZonedDateTime.from('2026-08-25T09:42:00[UTC]').withCalendar('hebrew');
    expect(formatImapDateTime(hebrew)).toBe('"25-Aug-2026 09:42:00 +0000"');
  });

  it('writes an offset with seconds in whole minutes', () => {
    expect(
      formatImapDateTime(Temporal.ZonedDateTime.from('1900-01-01T00:00:00[Europe/Paris]')),
    ).toBe('" 1-Jan-1900 00:00:00 +0009"');
  });
});

describe('buildAppendCommand', () => {
  const message = new TextEncoder().encode('Subject: hi');
  const text = (internalDate?: Temporal.ZonedDateTime) => {
    const [line] = buildAppendCommand('a1', 'Sent', ['\\Seen'], message, internalDate).lines;
    if (line === undefined) throw new Error('APPEND built no lines');
    return asciiToString(line.text);
  };

  it('omits the date-time when the caller has none, leaving the server to stamp it', () => {
    expect(text()).toBe('a1 APPEND "Sent" (\\Seen) ');
  });

  it('places the date-time between the flags and the literal', () => {
    expect(text(Temporal.ZonedDateTime.from('2026-08-08T09:48:03[Asia/Kolkata]'))).toBe(
      'a1 APPEND "Sent" (\\Seen) " 8-Aug-2026 09:48:03 +0530" ',
    );
  });
});

describe('buildUidExpungeCommand', () => {
  it('names the uids, so nobody else’s deletions are taken with them', () => {
    expect(
      asciiToString(buildUidExpungeCommand('a1', '3,7:9').lines[0]?.text ?? new Uint8Array()),
    ).toBe('a1 UID EXPUNGE 3,7:9\r\n');
  });
});

describe('buildUidSearchCommand', () => {
  const sent = (criteria: UidSearchCriteria) =>
    buildUidSearchCommand('a1', criteria)
      .lines.map(({ text, literal }) =>
        literal === undefined
          ? asciiToString(text)
          : `${asciiToString(text)}{${literal.length}}<${new TextDecoder().decode(literal)}>`,
      )
      .join('');
  const subject = (value: string) => sent({ key: 'SUBJECT', value });

  it('searches the one key it is given', () => {
    expect(subject('ICO')).toBe('a1 UID SEARCH SUBJECT "ICO"\r\n');
    expect(sent({ key: 'CC', value: 'ann' })).toBe('a1 UID SEARCH CC "ann"\r\n');
    expect(sent({ key: 'HEADER', header: 'Reply-To', value: 'ann' })).toBe(
      'a1 UID SEARCH HEADER "Reply-To" "ann"\r\n',
    );
    expect(sent({ key: 'UNSEEN' })).toBe('a1 UID SEARCH UNSEEN\r\n');
    expect(sent({ key: 'FLAGGED' })).toBe('a1 UID SEARCH FLAGGED\r\n');
  });

  it('writes a date as RFC 9051 has it', () => {
    expect(sent({ key: 'SINCE', date: Temporal.PlainDate.from('2026-02-01') })).toBe(
      'a1 UID SEARCH SINCE 1-Feb-2026\r\n',
    );
    expect(sent({ key: 'BEFORE', date: Temporal.PlainDate.from('2026-12-31') })).toBe(
      'a1 UID SEARCH BEFORE 31-Dec-2026\r\n',
    );
  });

  it('writes a day in another calendar as its ISO date', () => {
    const hebrew = Temporal.PlainDate.from('2024-09-10').withCalendar('hebrew');
    expect(sent({ key: 'SINCE', date: hebrew })).toBe('a1 UID SEARCH SINCE 10-Sep-2024\r\n');
  });

  it('escapes quotes and backslashes', () => {
    expect(subject('a "b" \\c')).toBe('a1 UID SEARCH SUBJECT "a \\"b\\" \\\\c"\r\n');
  });

  it('sends a value that is not printable ASCII as a UTF-8 literal, a header too', () => {
    expect(subject('Grüße')).toBe('a1 UID SEARCH CHARSET UTF-8 SUBJECT {7}<Grüße>\r\n');
    expect(sent({ key: 'HEADER', header: 'Reply-To', value: 'Grüße' })).toBe(
      'a1 UID SEARCH CHARSET UTF-8 HEADER "Reply-To" {7}<Grüße>\r\n',
    );
  });

  it('asks several keys as one command, which a message must all meet', () => {
    expect(
      sent([
        { key: 'UNSEEN' },
        { key: 'SINCE', date: Temporal.PlainDate.from('2026-02-01') },
        { key: 'FROM', value: 'stripe' },
      ]),
    ).toBe('a1 UID SEARCH UNSEEN SINCE 1-Feb-2026 FROM "stripe"\r\n');
    expect(sent([{ key: 'FROM', value: 'stripe' }])).toBe('a1 UID SEARCH FROM "stripe"\r\n');
  });

  it('names the charset once and sends each non-ASCII value as a literal among the others', () => {
    expect(
      sent([
        { key: 'UNSEEN' },
        { key: 'SUBJECT', value: 'Grüße' },
        { key: 'FROM', value: 'ann' },
        { key: 'TO', value: 'Grüße' },
      ]),
    ).toBe('a1 UID SEARCH CHARSET UTF-8 UNSEEN SUBJECT {7}<Grüße> FROM "ann" TO {7}<Grüße>\r\n');
  });

  it('asks for every message when it is given no key, rather than send a command that is malformed', () => {
    expect(sent([])).toBe('a1 UID SEARCH ALL\r\n');
  });

  it('never lets a line break into the command line', () => {
    expect(subject('a\r\nb DELETE')).toBe(
      'a1 UID SEARCH CHARSET UTF-8 SUBJECT {11}<a\r\nb DELETE>\r\n',
    );
  });
});
