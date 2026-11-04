import { describe, expect, it } from 'vitest';
import { stringToBytes } from './bytes.ts';
import { parseResponse } from './response.ts';
import { readLogicalLine, tokenizeLogicalLine } from './tokenizer.ts';

/** The names a whole `* 1 FETCH` line carries, through the real tokenizer, and what follows them. */
const parsed = (structure: string) => {
  const line = readLogicalLine(
    stringToBytes(`* 1 FETCH (BODYSTRUCTURE ${structure} UID 7 FLAGS (\\Seen))\r\n`),
  );
  if (line.status !== 'complete') throw new Error('incomplete');
  const tokens = tokenizeLogicalLine(line.line);
  if (!tokens.ok) throw new Error('untokenizable');
  const response = parseResponse(tokens.value);
  if (!response.ok || response.value.kind !== 'untagged') throw new Error('no response');
  if (response.value.untagged.kind !== 'fetch') throw new Error('no fetch');
  return response.value.untagged.items;
};

const namesOf = (structure: string) =>
  parsed(structure).flatMap(item => (item.kind === 'bodyStructure' ? item.attachmentNames : []));

const TEXT = '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 10 1 NIL NIL NIL NIL)';
const pdf = (params: string, disposition: string) =>
  `("APPLICATION" "PDF" ${params} NIL NIL "BASE64" 100 NIL ${disposition} NIL NIL)`;
const attached = (params: string) => pdf('NIL', `("ATTACHMENT" (${params}))`);

describe('attachment names in a BODYSTRUCTURE', () => {
  it('finds none in a message without a named part', () => {
    expect(namesOf(TEXT)).toEqual([]);
  });

  it('reads the disposition’s filename, and the type’s name without one', () => {
    expect(namesOf(attached('"FILENAME" "invoice.pdf"'))).toEqual(['invoice.pdf']);
    expect(namesOf(pdf('("NAME" "old.pdf")', 'NIL'))).toEqual(['old.pdf']);
    expect(namesOf(pdf('("NAME" "old.pdf")', '("ATTACHMENT" ("filename" "new.pdf"))'))).toEqual([
      'new.pdf',
    ]);
  });

  it('reads a part in a text part’s position, after its line count', () => {
    expect(
      namesOf('("TEXT" "PLAIN" NIL NIL NIL "7BIT" 10 1 NIL ("ATTACHMENT" ("FILENAME" "a.txt")))'),
    ).toEqual(['a.txt']);
  });

  it('walks nested multiparts, in part order, each name once', () => {
    const alternative = `(${TEXT} ${pdf('("NAME" "a.pdf")', 'NIL')} "ALTERNATIVE")`;
    expect(
      namesOf(
        `(${alternative} ${attached('"FILENAME" "b.pdf"')} ${attached('"FILENAME" "a.pdf"')} "MIXED")`,
      ),
    ).toEqual(['a.pdf', 'b.pdf']);
  });

  it('goes inside a forwarded message/rfc822, past its envelope', () => {
    const envelope =
      '("Sun, 1 Nov 2026 09:00:00 +0000" "Fwd" ((NIL NIL "a" "x.co")) NIL NIL NIL NIL NIL NIL NIL)';
    const inner = `(${TEXT} ${attached('"FILENAME" "inner.pdf"')} "MIXED")`;
    expect(
      namesOf(
        `("MESSAGE" "RFC822" ("NAME" "forwarded.eml") NIL NIL "7BIT" 500 ${envelope} ${inner} 20 NIL ("ATTACHMENT" ("FILENAME" "outer.eml")) NIL NIL)`,
      ),
    ).toEqual(['outer.eml', 'inner.pdf']);
  });

  describe('RFC 2231', () => {
    it('decodes a charset and percent escapes', () => {
      expect(namesOf(attached(`"FILENAME*" "UTF-8''Gr%C3%BC%C3%9Fe%20Rechnung.pdf"`))).toEqual([
        'Grüße Rechnung.pdf',
      ]);
      expect(namesOf(attached(`"filename*" "iso-8859-1'de'Gr%FC%DFe.pdf"`))).toEqual(['Grüße.pdf']);
    });

    it('joins continuations in number order', () => {
      expect(namesOf(attached('"FILENAME*1" "ice.pdf" "FILENAME*0" "invo"'))).toEqual([
        'invoice.pdf',
      ]);
    });

    it('joins the bytes of encoded continuations before decoding, so a character may straddle', () => {
      expect(
        namesOf(
          attached(`"FILENAME*0*" "UTF-8''Gr%C3" "FILENAME*1*" "%BC%C3%9Fe" "FILENAME*2" ".pdf"`),
        ),
      ).toEqual(['Grüße.pdf']);
    });

    it('prefers the extended form to a plain value beside it', () => {
      expect(
        namesOf(attached(`"FILENAME" "fallback.pdf" "FILENAME*" "UTF-8''caf%C3%A9.pdf"`)),
      ).toEqual(['café.pdf']);
    });

    it('falls back to the plain value when the extended one is odd', () => {
      for (const odd of [
        `"FILENAME*" "no-quotes%20at-all"`,
        `"FILENAME*" "UTF-8''bad%ZZescape"`,
        `"FILENAME*" "no-such-charset''a.pdf"`,
        `"FILENAME*" "UTF-8''%FF%FE"`,
        `"FILENAME*0" "a" "FILENAME*2" "gap"`,
      ]) {
        expect(namesOf(attached(`${odd} "FILENAME" "plain.pdf"`))).toEqual(['plain.pdf']);
        expect(namesOf(attached(odd))).toEqual([]);
      }
    });
  });

  it('decodes RFC 2047, which plenty of mailers put in a name though the RFC forbids it', () => {
    expect(namesOf(attached('"FILENAME" "=?UTF-8?B?R3LDvMOfZS5wZGY=?="'))).toEqual(['Grüße.pdf']);
    expect(namesOf(attached('"FILENAME" "=?ISO-8859-1?Q?caf=E9.pdf?="'))).toEqual(['café.pdf']);
    expect(namesOf(pdf('("NAME" "=?UTF-8?Q?a=20b.pdf?=")', 'NIL'))).toEqual(['a b.pdf']);
  });

  it('reads a name sent as a literal, and raw UTF-8 sent quoted', () => {
    const literal = '"Grüße.pdf"'.slice(1, -1);
    const size = stringToBytes(literal).length;
    expect(
      namesOf(
        `("APPLICATION" "PDF" NIL NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" {${size}}\r\n${literal})) NIL NIL)`,
      ),
    ).toEqual(['Grüße.pdf']);
    expect(namesOf(attached('"FILENAME" "Grüße.pdf"'))).toEqual(['Grüße.pdf']);
  });

  it('treats garbage as no name, and goes on reading the response after it', () => {
    for (const garbage of [
      'NIL',
      '()',
      '(())',
      '("TEXT")',
      '("APPLICATION" "PDF" 5 NIL NIL "BASE64" 100 NIL 7)',
      '("APPLICATION" "PDF" ("NAME") NIL NIL "BASE64" 100 NIL ("ATTACHMENT"))',
      '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" NIL)))',
      '("APPLICATION" "PDF" NIL NIL NIL "BASE64" 100 NIL ("ATTACHMENT" ("FILENAME" "   ")))',
      '("MESSAGE" "RFC822" NIL NIL NIL "7BIT" 5 NIL NIL NIL)',
    ]) {
      const items = parsed(garbage);
      expect(items.flatMap(i => (i.kind === 'bodyStructure' ? i.attachmentNames : []))).toEqual([]);
      expect(items.find(i => i.kind === 'uid')).toEqual({ kind: 'uid', uid: 7 });
      expect(items.find(i => i.kind === 'flags')).toEqual({ kind: 'flags', flags: ['\\Seen'] });
    }
  });

  it('survives a structure nested past reason, and caps what one message can add', () => {
    expect(namesOf(`${'('.repeat(100_000)}"x"${')'.repeat(100_000)}`)).toEqual([]);
    expect(namesOf(attached(`"FILENAME" "${'a'.repeat(300)}.pdf"`))).toEqual([]);
    const many = Array.from({ length: 100 }, (_, n) => attached(`"FILENAME" "${n}.pdf"`));
    expect(namesOf(`(${many.join(' ')} "MIXED")`)).toHaveLength(64);
  });
});
