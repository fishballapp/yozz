// @vitest-environment jsdom
import { DEFAULT_MAX_LITERAL_BYTES } from '@yozz.app/imap';
import { describe, expect, it } from 'vitest';
import { fetchBody, parseBody, toParagraphs } from './bodies';

const raw = (text: string) => new TextEncoder().encode(text.replace(/\n/g, '\r\n'));

describe('parseBody', () => {
  it('an HTML-only message reduces to paragraphs but does not claim a text part', async () => {
    const body = await parseBody(
      raw(`Content-Type: text/html; charset=utf-8

<p>Only <b>markup</b> here.</p>
`),
    );
    expect(body.paragraphs).toEqual(['Only markup here.']);
    expect(body.hasTextPart).toBe(false);
  });

  it('prefers the text part, decodes quoted-printable, and keeps attachments with their bytes', async () => {
    const body = await parseBody(
      raw(`Content-Type: multipart/mixed; boundary="b"
Subject: hi

--b
Content-Type: multipart/alternative; boundary="a"

--a
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 at 9.

See you.
--a
Content-Type: text/html; charset=utf-8

<p>Caf&eacute; at 9.</p><p>See you.</p>
--a--
--b
Content-Type: application/pdf; name="invoice.pdf"
Content-Disposition: attachment; filename="invoice.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--b--
`),
    );
    expect(body.paragraphs).toEqual(['Café at 9.', 'See you.']);
    expect(body.hasTextPart).toBe(true);
    expect(body.attachments).toHaveLength(1);
    const [file] = body.attachments;
    expect(file?.name).toBe('invoice.pdf');
    expect(file?.kind).toBe('pdf');
    expect(file?.size).toBe(5);
    expect(Array.from(file?.content ?? [])).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });
});

describe('parseBody html', () => {
  it('keeps the html body alongside the text, inlining cid images as data URIs', async () => {
    const body = await parseBody(
      raw(`Content-Type: multipart/related; boundary="r"
Subject: hi

--r
Content-Type: multipart/alternative; boundary="a"

--a
Content-Type: text/plain

See the chart.
--a
Content-Type: text/html

<p>See the <img src="cid:chart@x"> chart.</p>
--a--
--r
Content-Type: image/png
Content-ID: <chart@x>
Content-Transfer-Encoding: base64
Content-Disposition: inline

iVBORw0=
--r--
`),
    );
    expect(body.paragraphs).toEqual(['See the chart.']);
    expect(body.html).toContain('src="data:image/png;base64,iVBORw0="');
    expect(body.html).not.toContain('cid:');
    expect(body.inlineImagesTruncated).toBe(false);
    // The cid part is the body's image, not a file the sender attached.
    expect(body.attachments).toHaveLength(0);
  });

  it('does not let a cid that prefixes another eat into it', async () => {
    const body = await parseBody(
      raw(`Content-Type: multipart/related; boundary="r"

--r
Content-Type: text/plain

two charts
--r
Content-Type: text/html

<img src="cid:a@x"><img src="cid:a@x2">
--r
Content-Type: image/png
Content-ID: <a@x>
Content-Transfer-Encoding: base64

AAAA
--r
Content-Type: image/gif
Content-ID: <a@x2>
Content-Transfer-Encoding: base64

BBBB
--r--
`),
    );
    expect(body.html).toContain('data:image/png;base64,AAAA');
    expect(body.html).toContain('data:image/gif;base64,BBBB');
    expect(body.html).not.toContain('cid:');
  });

  it('refuses a CID part whose declared type is not a safe raster image', async () => {
    const body = await parseBody(
      raw(`Content-Type: multipart/related; boundary="r"

--r
Content-Type: text/plain

chart
--r
Content-Type: text/html

<img src="CID:chart@x">
--r
Content-Type: image/svg+xml
Content-ID: <chart@x>
Content-Transfer-Encoding: base64

AAAA
--r--
`),
    );
    expect(body.html).toContain('src="CID:chart@x"');
    expect(body.html).not.toContain('data:image/svg+xml');
    expect(body.inlineImagesTruncated).toBe(true);
  });

  it('inlines the common image/jpg alias as a safe raster image', async () => {
    const body = await parseBody(
      raw(`Content-Type: multipart/related; boundary="r"

--r
Content-Type: text/html

<img src="cid:photo@x">
--r
Content-Type: image/jpg
Content-ID: <photo@x>
Content-Transfer-Encoding: base64

AAAA
--r--
`),
    );
    expect(body.html).toContain('data:image/jpg;base64,AAAA');
  });

  it('does not multiply one CID image beyond the reference ceiling', async () => {
    const references = Array.from({ length: 65 }, () => '<img src="cid:chart@x">').join('');
    const body = await parseBody(
      raw(`Content-Type: multipart/related; boundary="r"

--r
Content-Type: text/html

${references}
--r
Content-Type: image/png
Content-ID: <chart@x>
Content-Transfer-Encoding: base64

AAAA
--r--
`),
    );
    expect(body.html).not.toContain('data:image/png');
    expect(body.html?.match(/cid:chart@x/g)).toHaveLength(65);
    expect(body.inlineImagesTruncated).toBe(true);
  });

  it('falls back to bounded text for an oversized HTML body', async () => {
    const body = await parseBody(
      raw(`Content-Type: text/html

<p>${'x'.repeat(2 * 1024 * 1024)}</p>`),
    );
    expect(body.html).toBeUndefined();
    expect(body.paragraphs.join('').length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('reduces pathologically deep HTML without overflowing the JavaScript stack', async () => {
    const body = await parseBody(
      raw(`Content-Type: text/html

${'<div>'.repeat(2_000)}deep<script>garbage()</script><style>.garbage{}</style>${'</div>'.repeat(2_000)}`),
    );
    expect(body.paragraphs).toContain('deep');
    expect(body.paragraphs.join(' ')).not.toContain('garbage');
  });

  it('has no html for a plain message', async () => {
    const body = await parseBody(raw(`Content-Type: text/plain\n\nhi\n`));
    expect(body.html).toBeUndefined();
    expect(body.paragraphs).toEqual(['hi']);
  });
});

describe('fetchBody size boundary', () => {
  const unusedRun = (async () => {
    throw new Error('run should not be called');
  }) as Parameters<typeof fetchBody>[0];

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('refuses an invalid advertised size (%s) before connecting', async size => {
    await expect(fetchBody(unusedRun, 'INBOX', 1, size)).resolves.toEqual({
      ok: false,
      error: { kind: 'error', detail: 'Message size is unavailable' },
    });
  });

  it('refuses an oversized message before connecting', async () => {
    await expect(fetchBody(unusedRun, 'INBOX', 1, DEFAULT_MAX_LITERAL_BYTES + 1)).resolves.toEqual({
      ok: false,
      error: { kind: 'error', detail: 'Message is too large to open safely' },
    });
  });
});

describe('toParagraphs', () => {
  it('splits on blank lines and keeps single line breaks inside a paragraph', () => {
    expect(toParagraphs('a\r\nb\r\n\r\n\r\nc\n')).toEqual(['a\nb', 'c']);
  });
});
