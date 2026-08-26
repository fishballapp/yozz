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

describe('envelope and fetch parsing', () => {
  it('parses Gmail-shaped FETCH response', () => {
    const raw =
      '* 1 FETCH (UID 54321 RFC822.SIZE 3456 INTERNALDATE "23-Aug-2026 10:15:00 +0000" FLAGS (\\Seen \\Flagged) ENVELOPE ("Sun, 23 Aug 2026 10:15:00 +0000" "=?UTF-8?B?VXBkYXRlIGZyb20gWW96eg==?=" ((NIL NIL "alice" "example.com")) ((NIL NIL "alice" "example.com")) ((NIL NIL "reply" "example.com")) ((NIL NIL "bob" "example.com")) NIL NIL "<inreply@example.com>" "<msg-101@example.com>"))\r\n';

    const res = parseLine(raw);
    expect(res.ok).toBe(true);
    if (!res.ok || res.value.kind !== 'untagged' || res.value.untagged.kind !== 'fetch') return;

    expect(res.value.untagged.seq).toBe(1);
    const items = res.value.untagged.items;

    const uidItem = items.find(i => i.kind === 'uid');
    expect(uidItem).toEqual({ kind: 'uid', uid: 54321 });

    const sizeItem = items.find(i => i.kind === 'size');
    expect(sizeItem).toEqual({ kind: 'size', size: 3456 });

    const dateItem = items.find(i => i.kind === 'internalDate');
    expect(dateItem).toEqual({ kind: 'internalDate', date: '23-Aug-2026 10:15:00 +0000' });

    const flagsItem = items.find(i => i.kind === 'flags');
    expect(flagsItem).toEqual({ kind: 'flags', flags: ['\\Seen', '\\Flagged'] });

    const envItem = items.find(i => i.kind === 'envelope');
    expect(envItem).toBeDefined();
    if (envItem?.kind === 'envelope') {
      expect(envItem.envelope.date).toBe('Sun, 23 Aug 2026 10:15:00 +0000');
      expect(envItem.envelope.subject).toBe('Update from Yozz');
      expect(envItem.envelope.subjectRaw).toBe('=?UTF-8?B?VXBkYXRlIGZyb20gWW96eg==?=');
      expect(envItem.envelope.from).toEqual([
        { name: null, mailbox: 'alice', host: 'example.com' },
      ]);
      expect(envItem.envelope.to).toEqual([{ name: null, mailbox: 'bob', host: 'example.com' }]);
      expect(envItem.envelope.inReplyTo).toBe('<inreply@example.com>');
      expect(envItem.envelope.messageId).toBe('<msg-101@example.com>');
    }
  });

  it('parses Dovecot-shaped FETCH response with group address flattening and BODYSTRUCTURE parts', () => {
    const raw =
      '* 2 FETCH (FLAGS (\\Seen) INTERNALDATE "17-Jul-1996 02:44:25 -0700" RFC822.SIZE 4421 UID 1002 BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "US-ASCII") NIL NIL "7BIT" 1152 23) ("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "8BIT" 2048 40) "ALTERNATIVE") ("IMAGE" "JPEG" ("NAME" "photo.jpg") NIL NIL "BASE64" 30000) "MIXED") ENVELOPE ("17-Jul-1996 02:44:25 -0700" "Meeting Agenda" ((NIL NIL "Core Team" NIL) ("Charlie" NIL "charlie" "example.com") ("David" NIL "david" "example.com") (NIL NIL NIL NIL)) NIL NIL ((NIL NIL "all" "example.com")) NIL NIL NIL "<meeting-1@example.com>"))\r\n';

    const res = parseLine(raw);
    expect(res.ok).toBe(true);
    if (!res.ok || res.value.kind !== 'untagged' || res.value.untagged.kind !== 'fetch') return;

    const items = res.value.untagged.items;

    const bsItem = items.find(i => i.kind === 'bodyStructure');
    expect(bsItem).toBeDefined();
    if (bsItem?.kind === 'bodyStructure') {
      expect(bsItem.parts).toEqual(['TEXT/PLAIN', 'TEXT/HTML', 'IMAGE/JPEG']);
    }

    const envItem = items.find(i => i.kind === 'envelope');
    expect(envItem).toBeDefined();
    if (envItem?.kind === 'envelope') {
      // Group (Core Team) flattened to Charlie and David
      expect(envItem.envelope.from).toEqual([
        { name: 'Charlie', mailbox: 'charlie', host: 'example.com' },
        { name: 'David', mailbox: 'david', host: 'example.com' },
      ]);
      expect(envItem.envelope.subject).toBe('Meeting Agenda');
    }
  });

  it('parses BODY[] {n} FETCH response containing bare LF, parentheses and asterisks', () => {
    const rawBody = 'Hello\n)\n*\nWorld\r\nTest';
    const bodyBytes = stringToBytes(rawBody);
    const headerBytes = stringToBytes(`* 3 FETCH (UID 42 BODY[] {${bodyBytes.length}}\r\n`);
    const footerBytes = stringToBytes(')\r\n');

    const totalBytes = new Uint8Array(headerBytes.length + bodyBytes.length + footerBytes.length);
    totalBytes.set(headerBytes, 0);
    totalBytes.set(bodyBytes, headerBytes.length);
    totalBytes.set(footerBytes, headerBytes.length + bodyBytes.length);

    const lineRes = readLogicalLine(totalBytes);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    const resp = parseResponse(tokRes.value);
    expect(resp.ok).toBe(true);
    if (!resp.ok || resp.value.kind !== 'untagged' || resp.value.untagged.kind !== 'fetch') return;

    expect(resp.value.untagged.seq).toBe(3);
    const items = resp.value.untagged.items;

    const uidItem = items.find(i => i.kind === 'uid');
    expect(uidItem).toEqual({ kind: 'uid', uid: 42 });

    const bodyItem = items.find(i => i.kind === 'body');
    expect(bodyItem).toBeDefined();
    if (bodyItem?.kind === 'body') {
      expect(bodyItem.section).toBe('');
      expect(bodyItem.bytes).toEqual(bodyBytes);
    }
  });
});
