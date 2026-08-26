import { describe, expect, it } from 'vitest';
import { stringToBytes } from './bytes.ts';
import { readLogicalLine, tokenizeLogicalLine } from './tokenizer.ts';

describe('tokenizer', () => {
  it('tokenizes atoms and numbers', () => {
    const input = stringToBytes('A001 OK [CAPABILITY IMAP4rev1] 12345\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    expect(tokRes.value).toEqual([
      { kind: 'atom', value: 'A001' },
      { kind: 'atom', value: 'OK' },
      { kind: 'lbracket' },
      { kind: 'atom', value: 'CAPABILITY' },
      { kind: 'atom', value: 'IMAP4rev1' },
      { kind: 'rbracket' },
      { kind: 'number', value: 12345 },
    ]);
  });

  it('tokenizes quoted strings with escaped quotes and backslashes', () => {
    const input = stringToBytes('TAG "Hello \\"World\\\\" "Another \\\\ test"\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    expect(tokRes.value).toEqual([
      { kind: 'atom', value: 'TAG' },
      { kind: 'quoted', value: 'Hello "World\\' },
      { kind: 'quoted', value: 'Another \\ test' },
    ]);
  });

  it('handles literals mid-line', () => {
    const input = stringToBytes('* 1 FETCH (BODY[TEXT] {12}\r\nHello World! FLAGS (\\Seen))\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    expect(tokRes.value).toEqual([
      { kind: 'atom', value: '*' },
      { kind: 'number', value: 1 },
      { kind: 'atom', value: 'FETCH' },
      { kind: 'lparen' },
      { kind: 'atom', value: 'BODY' },
      { kind: 'lbracket' },
      { kind: 'atom', value: 'TEXT' },
      { kind: 'rbracket' },
      { kind: 'literal', value: stringToBytes('Hello World!') },
      { kind: 'atom', value: 'FLAGS' },
      { kind: 'lparen' },
      { kind: 'atom', value: '\\Seen' },
      { kind: 'rparen' },
      { kind: 'rparen' },
    ]);
  });

  it('tokenizes nested lists and NIL', () => {
    const input = stringToBytes('FLAGS ((\\Seen \\Answered) NIL (\\Draft))\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    expect(tokRes.value).toEqual([
      { kind: 'atom', value: 'FLAGS' },
      { kind: 'lparen' },
      { kind: 'lparen' },
      { kind: 'atom', value: '\\Seen' },
      { kind: 'atom', value: '\\Answered' },
      { kind: 'rparen' },
      { kind: 'nil' },
      { kind: 'lparen' },
      { kind: 'atom', value: '\\Draft' },
      { kind: 'rparen' },
      { kind: 'rparen' },
    ]);
  });

  it('fails on bare LF', () => {
    const input = stringToBytes('* OK Dovecot\nready\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('failure');
    if (lineRes.status === 'failure') {
      expect(lineRes.failure.kind).toBe('protocol');
    }
  });

  it('fails on unterminated quoted string', () => {
    const input = stringToBytes('TAG "unterminated quoted string\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(false);
    if (!tokRes.ok && tokRes.reason.kind === 'protocol') {
      expect(tokRes.reason.detail).toContain('Unterminated quoted string');
    }
  });

  it('fails on literal longer than maxLiteralBytes', () => {
    const input = stringToBytes('* 1 FETCH (BODY {200}\r\n...\r\n');
    const lineRes = readLogicalLine(input, 100);
    expect(lineRes.status).toBe('failure');
    if (lineRes.status === 'failure' && lineRes.failure.kind === 'protocol') {
      expect(lineRes.failure.detail).toContain('exceeds maxLiteralBytes');
    }
  });

  it('keeps a number above 2^32 - 1 as an atom of digits (Gmail X-GM-THRID is 64-bit)', () => {
    const input = stringToBytes('* 1 FETCH (X-GM-THRID 1834682380345891234)\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('complete');
    if (lineRes.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(lineRes.line);
    expect(tokRes.ok).toBe(true);
    if (tokRes.ok) {
      expect(tokRes.value).toContainEqual({ kind: 'atom', value: '1834682380345891234' });
    }
  });

  it('fails on unsafe integer literal header (twenty 9s) as protocol failure', () => {
    const input = stringToBytes('* 1 FETCH (BODY {99999999999999999999}\r\n* 2 EXISTS\r\n');
    const lineRes = readLogicalLine(input);
    expect(lineRes.status).toBe('failure');
    if (lineRes.status === 'failure' && lineRes.failure.kind === 'protocol') {
      expect(lineRes.failure.detail).toContain('32-bit unsigned integer');
    }
  });

  it('resumes literal parsing across chunks and yields complete line', () => {
    const headerBytes = stringToBytes('* 1 FETCH (BODY[] {10}\r\n');
    const literalChunk1 = stringToBytes('12345');
    const literalChunk2 = stringToBytes('67890');
    const footerBytes = stringToBytes(' FLAGS (\\Seen))\r\n');

    let buffer = headerBytes;
    let res = readLogicalLine(buffer);
    expect(res.status).toBe('incomplete');
    if (res.status !== 'incomplete') return;
    expect(res.needBytes).toBe(headerBytes.length + 10);

    buffer = new Uint8Array([...headerBytes, ...literalChunk1]);
    res = readLogicalLine(buffer, undefined, res);
    expect(res.status).toBe('incomplete');
    if (res.status !== 'incomplete') return;

    buffer = new Uint8Array([...headerBytes, ...literalChunk1, ...literalChunk2, ...footerBytes]);
    res = readLogicalLine(buffer, undefined, res);
    expect(res.status).toBe('complete');
    if (res.status !== 'complete') return;

    const tokRes = tokenizeLogicalLine(res.line);
    expect(tokRes.ok).toBe(true);
    if (!tokRes.ok) return;

    expect(tokRes.value).toEqual([
      { kind: 'atom', value: '*' },
      { kind: 'number', value: 1 },
      { kind: 'atom', value: 'FETCH' },
      { kind: 'lparen' },
      { kind: 'atom', value: 'BODY' },
      { kind: 'lbracket' },
      { kind: 'rbracket' },
      { kind: 'literal', value: stringToBytes('1234567890') },
      { kind: 'atom', value: 'FLAGS' },
      { kind: 'lparen' },
      { kind: 'atom', value: '\\Seen' },
      { kind: 'rparen' },
      { kind: 'rparen' },
    ]);
  });
});
