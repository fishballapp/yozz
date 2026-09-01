import { describe, expect, it } from 'vitest';
import { asciiToString } from './bytes.ts';
import { buildAppendCommand, buildUidExpungeCommand, formatImapDateTime } from './commands.ts';

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
