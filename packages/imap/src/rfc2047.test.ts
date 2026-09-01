import { describe, expect, it } from 'vitest';
import { decodeRfc2047 } from './rfc2047.ts';

describe('RFC 2047 decoder', () => {
  it('decodes simple Q and B encoded words', () => {
    expect(decodeRfc2047('=?UTF-8?B?SGVsbG8gV29ybGQ=?=')).toBe('Hello World');
    expect(decodeRfc2047('=?UTF-8?Q?Hello_World!?=')).toBe('Hello World!');
    expect(decodeRfc2047('=?ISO-8859-1?Q?Caf=E9?=')).toBe('Café');
  });

  it('decodes GB2312 if supported by runtime', () => {
    // GB2312 for '中文' is 0xD6 0xD0 0xCE 0xC4 -> Base64 1tDOxA==
    let isGb2312Supported = true;
    try {
      new TextDecoder('gb2312');
    } catch {
      isGb2312Supported = false;
    }

    if (isGb2312Supported) {
      expect(decodeRfc2047('=?GB2312?B?1tDOxA==?=')).toBe('中文');
    } else {
      expect(decodeRfc2047('=?GB2312?B?1tDOxA==?=')).toBe('=?GB2312?B?1tDOxA==?=');
    }
  });

  it('joins adjacent encoded-word bytes before charset decoding (multibyte split)', () => {
    // '日' in UTF-8 is [0xE6, 0x97, 0xA5].
    // Word 1 carries [0xE6, 0x97] -> base64 '5pc='
    // Word 2 carries [0xA5]       -> base64 'pQ=='
    const splitWord = '=?UTF-8?B?5pc=?= =?UTF-8?B?pQ==?=';
    expect(decodeRfc2047(splitWord)).toBe('日');
  });

  it('discards linear white space between adjacent encoded words only', () => {
    const input = 'Subject: =?UTF-8?Q?Hello?=   =?UTF-8?Q?_World?=';
    expect(decodeRfc2047(input)).toBe('Subject: Hello World');

    const inputWithText = 'Subject: =?UTF-8?Q?Hello?= and =?UTF-8?Q?World?=';
    expect(decodeRfc2047(inputWithText)).toBe('Subject: Hello and World');
  });

  it('leaves unknown charset intact', () => {
    const input = '=?UNKNOWN-CHARSET-12345?Q?Something?=';
    expect(decodeRfc2047(input)).toBe('=?UNKNOWN-CHARSET-12345?Q?Something?=');
  });

  it('never re-scans the output (single-pass decode)', () => {
    // The Q-encoded text decodes to `=?UTF-8?Q?x?=`; a decoder that re-scans its output would then produce `x`.
    const nested = '=?UTF-8?Q?=3D=3FUTF-8=3FQ=3Fx=3F=3D?=';
    expect(decodeRfc2047(nested)).toBe('=?UTF-8?Q?x?=');
  });
});
