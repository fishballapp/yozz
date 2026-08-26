import { describe, expect, it } from 'vitest';
import { stringToBytes } from './bytes.ts';
import { parseResponse } from './response.ts';
import { readLogicalLine, tokenizeLogicalLine } from './tokenizer.ts';

const parseLine = (text: string) => {
  const lineRes = readLogicalLine(stringToBytes(text));
  if (lineRes.status !== 'complete') throw new Error(`Incomplete line: ${text}`);
  const tokRes = tokenizeLogicalLine(lineRes.line);
  if (!tokRes.ok) {
    const msg = tokRes.reason.kind === 'protocol' ? tokRes.reason.detail : tokRes.reason.kind;
    throw new Error(`Tokenize error: ${msg}`);
  }
  return parseResponse(tokRes.value);
};

describe('response parser', () => {
  it('parses Dovecot greeting with capabilities', () => {
    const res = parseLine(
      '* OK [CAPABILITY IMAP4rev1 SASL-IR LOGIN-REFERRALS ID ENABLE IDLE LITERAL+ AUTH=PLAIN] Dovecot ready.\r\n',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toEqual({
      kind: 'untagged',
      untagged: {
        kind: 'status',
        status: 'OK',
        code: {
          kind: 'capability',
          capabilities: [
            'IMAP4rev1',
            'SASL-IR',
            'LOGIN-REFERRALS',
            'ID',
            'ENABLE',
            'IDLE',
            'LITERAL+',
            'AUTH=PLAIN',
          ],
        },
        text: 'Dovecot ready.',
      },
    });
  });

  it('parses Gmail greeting without response code', () => {
    const res = parseLine('* OK Gimap ready for requests from 1.2.3.4 abc\r\n');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value).toEqual({
      kind: 'untagged',
      untagged: {
        kind: 'status',
        status: 'OK',
        code: null,
        text: 'Gimap ready for requests from 1.2.3.4 abc',
      },
    });
  });

  it('parses untagged status responses: NO, BAD, BYE, PREAUTH', () => {
    const noRes = parseLine('* NO [ALERT] Server is in maintenance mode\r\n');
    expect(noRes.ok).toBe(true);
    if (noRes.ok && noRes.value.kind === 'untagged' && noRes.value.untagged.kind === 'status') {
      expect(noRes.value.untagged.status).toBe('NO');
      expect(noRes.value.untagged.code).toEqual({ kind: 'alert' });
      expect(noRes.value.untagged.text).toBe('Server is in maintenance mode');
    }

    const badRes = parseLine('* BAD Syntax error in command\r\n');
    expect(badRes.ok).toBe(true);
    if (badRes.ok && badRes.value.kind === 'untagged' && badRes.value.untagged.kind === 'status') {
      expect(badRes.value.untagged.status).toBe('BAD');
      expect(badRes.value.untagged.code).toBeNull();
      expect(badRes.value.untagged.text).toBe('Syntax error in command');
    }

    const byeRes = parseLine('* BYE Autologout; idle for too long\r\n');
    expect(byeRes.ok).toBe(true);
    if (byeRes.ok && byeRes.value.kind === 'untagged' && byeRes.value.untagged.kind === 'status') {
      expect(byeRes.value.untagged.status).toBe('BYE');
      expect(byeRes.value.untagged.text).toBe('Autologout; idle for too long');
    }

    const preauthRes = parseLine('* PREAUTH Logged in as administrator\r\n');
    expect(preauthRes.ok).toBe(true);
    if (
      preauthRes.ok &&
      preauthRes.value.kind === 'untagged' &&
      preauthRes.value.untagged.kind === 'status'
    ) {
      expect(preauthRes.value.untagged.status).toBe('PREAUTH');
      expect(preauthRes.value.untagged.text).toBe('Logged in as administrator');
    }
  });

  it('parses untagged CAPABILITY', () => {
    const res = parseLine('* CAPABILITY IMAP4rev1 UNSELECT IDLE NAMESPACE\r\n');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({
        kind: 'untagged',
        untagged: {
          kind: 'capability',
          capabilities: ['IMAP4rev1', 'UNSELECT', 'IDLE', 'NAMESPACE'],
        },
      });
    }
  });

  it('parses untagged LIST with modified UTF-7 mailbox name', () => {
    const res = parseLine('* LIST (\\HasNoChildren \\Drafts) "/" "INBOX/&ZeVnLIqe-"\r\n');
    expect(res.ok).toBe(true);
    if (res.ok && res.value.kind === 'untagged' && res.value.untagged.kind === 'list') {
      expect(res.value.untagged.mailbox.attributes).toEqual(['\\HasNoChildren', '\\Drafts']);
      expect(res.value.untagged.mailbox.delimiter).toBe('/');
      expect(res.value.untagged.mailbox.name).toBe('INBOX/日本語');
    }
  });

  it('parses untagged FLAGS, EXISTS, RECENT, EXPUNGE, SEARCH', () => {
    const flags = parseLine('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
    expect(flags.ok).toBe(true);
    if (flags.ok && flags.value.kind === 'untagged' && flags.value.untagged.kind === 'flags') {
      expect(flags.value.untagged.flags).toEqual([
        '\\Answered',
        '\\Flagged',
        '\\Deleted',
        '\\Seen',
        '\\Draft',
      ]);
    }

    const exists = parseLine('* 42 EXISTS\r\n');
    expect(exists.ok).toBe(true);
    if (exists.ok && exists.value.kind === 'untagged' && exists.value.untagged.kind === 'exists') {
      expect(exists.value.untagged.count).toBe(42);
    }

    const recent = parseLine('* 2 RECENT\r\n');
    expect(recent.ok).toBe(true);
    if (recent.ok && recent.value.kind === 'untagged' && recent.value.untagged.kind === 'recent') {
      expect(recent.value.untagged.count).toBe(2);
    }

    const expunge = parseLine('* 7 EXPUNGE\r\n');
    expect(expunge.ok).toBe(true);
    if (
      expunge.ok &&
      expunge.value.kind === 'untagged' &&
      expunge.value.untagged.kind === 'expunge'
    ) {
      expect(expunge.value.untagged.seq).toBe(7);
    }

    const search = parseLine('* SEARCH 1 3 5 8 13 21\r\n');
    expect(search.ok).toBe(true);
    if (search.ok && search.value.kind === 'untagged' && search.value.untagged.kind === 'search') {
      expect(search.value.untagged.uids).toEqual([1, 3, 5, 8, 13, 21]);
    }
  });

  it('parses unknown untagged responses without failing', () => {
    const res = parseLine('* STATUS INBOX (MESSAGES 123 UNSEEN 4)\r\n');
    expect(res.ok).toBe(true);
    if (res.ok && res.value.kind === 'untagged' && res.value.untagged.kind === 'unknown') {
      expect(res.value.untagged.name).toBe('STATUS');
    }
  });

  it('parses tagged responses with and without codes', () => {
    const taggedOk = parseLine('A0001 OK [READ-WRITE] Select completed.\r\n');
    expect(taggedOk.ok).toBe(true);
    if (taggedOk.ok && taggedOk.value.kind === 'tagged') {
      expect(taggedOk.value.tag).toBe('A0001');
      expect(taggedOk.value.status).toBe('OK');
      expect(taggedOk.value.code).toEqual({ kind: 'readWrite' });
      expect(taggedOk.value.text).toBe('Select completed.');
    }

    const taggedNo = parseLine('A0002 NO [AUTHENTICATIONFAILED] Authentication failed.\r\n');
    expect(taggedNo.ok).toBe(true);
    if (taggedNo.ok && taggedNo.value.kind === 'tagged') {
      expect(taggedNo.value.tag).toBe('A0002');
      expect(taggedNo.value.status).toBe('NO');
      expect(taggedNo.value.code).toEqual({
        kind: 'other',
        code: 'AUTHENTICATIONFAILED',
        args: [],
      });
      expect(taggedNo.value.text).toBe('Authentication failed.');
    }

    const taggedBad = parseLine('A0003 BAD Unknown command.\r\n');
    expect(taggedBad.ok).toBe(true);
    if (taggedBad.ok && taggedBad.value.kind === 'tagged') {
      expect(taggedBad.value.tag).toBe('A0003');
      expect(taggedBad.value.status).toBe('BAD');
      expect(taggedBad.value.code).toBeNull();
      expect(taggedBad.value.text).toBe('Unknown command.');
    }
  });

  it('parses continuation responses', () => {
    const cont1 = parseLine('+ go ahead\r\n');
    expect(cont1.ok).toBe(true);
    if (cont1.ok && cont1.value.kind === 'continuation') {
      expect(cont1.value.text).toBe('go ahead');
    }

    const cont2 = parseLine('+\r\n');
    expect(cont2.ok).toBe(true);
    if (cont2.ok && cont2.value.kind === 'continuation') {
      expect(cont2.value.text).toBe('');
    }
  });
});
