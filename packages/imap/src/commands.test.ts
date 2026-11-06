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
  it('space-pads the day and names the month, in the local zone', () => {
    // Local zone, so only the shape is asserted.
    expect(formatImapDateTime(new Date(2026, 7, 8, 9, 48, 3))).toMatch(
      /^" 8-Aug-2026 09:48:03 [+-]\d{4}"$/,
    );
    expect(formatImapDateTime(new Date(2026, 11, 25, 23, 5, 0))).toMatch(
      /^"25-Dec-2026 23:05:00 [+-]\d{4}"$/,
    );
  });
});

describe('buildAppendCommand', () => {
  const message = new TextEncoder().encode('Subject: hi');
  const text = (internalDate?: Date) => {
    const [line] = buildAppendCommand('a1', 'Sent', ['\\Seen'], message, internalDate).lines;
    if (line === undefined) throw new Error('APPEND built no lines');
    return asciiToString(line.text);
  };

  it('omits the date-time when the caller has none, leaving the server to stamp it', () => {
    expect(text()).toBe('a1 APPEND "Sent" (\\Seen) ');
  });

  it('places the date-time between the flags and the literal', () => {
    expect(text(new Date(2026, 7, 8, 9, 48, 3))).toMatch(
      /^a1 APPEND "Sent" \(\\Seen\) " 8-Aug-2026 09:48:03 [+-]\d{4}" $/,
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
    expect(sent({ key: 'SINCE', date: { year: 2026, month: 2, day: 1 } })).toBe(
      'a1 UID SEARCH SINCE 1-Feb-2026\r\n',
    );
    expect(sent({ key: 'BEFORE', date: { year: 2026, month: 12, day: 31 } })).toBe(
      'a1 UID SEARCH BEFORE 31-Dec-2026\r\n',
    );
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
        { key: 'SINCE', date: { year: 2026, month: 2, day: 1 } },
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
