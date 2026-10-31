import { DEFAULT_MAX_LITERAL_BYTES } from '@yozz.app/imap';
import { beforeAll, describe, expect, it } from 'vitest';
import { signMessage } from '../testing/dkim-signer.ts';
import { stubImapClient } from '../testing/fake-imap-client.ts';
import { memoryMailCache } from '../testing/memory-mail-cache.ts';
import { fetchBody, fetchBodyAt, htmlToText, parseBody } from './bodies.ts';
import { MAX_CACHED_BODY_BYTES } from './body-state.ts';
import type { TxtLookup } from './dkim.ts';

const raw = (text: string) => new TextEncoder().encode(text.replace(/\n/g, '\r\n'));

const noKeys: TxtLookup = async () => [];

const parse = (data: Uint8Array, lookupTxt: TxtLookup = noKeys) => parseBody(data, lookupTxt);

describe('parseBody', () => {
  it('an HTML-only message reduces to paragraphs but does not claim a text part', async () => {
    const body = await parse(
      raw(`Content-Type: text/html; charset=utf-8

<p>Only <b>markup</b> here.</p>
`),
    );
    expect(body.paragraphs).toEqual(['Only markup here.']);
    expect(body.hasTextPart).toBe(false);
  });

  it('prefers the text part, decodes quoted-printable, and keeps attachments with their bytes', async () => {
    const body = await parse(
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
    const body = await parse(
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
    const body = await parse(
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
    const body = await parse(
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
    const body = await parse(
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
    const body = await parse(
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
    const body = await parse(
      raw(`Content-Type: text/html

<p>${'x'.repeat(2 * 1024 * 1024)}</p>`),
    );
    expect(body.html).toBeUndefined();
    expect(body.paragraphs.join('').length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('reduces pathologically deep HTML without overflowing the JavaScript stack', async () => {
    const body = await parse(
      raw(`Content-Type: text/html

${'<div>'.repeat(2_000)}deep<script>garbage()</script><style>.garbage{}</style>${'</div>'.repeat(2_000)}`),
    );
    expect(body.paragraphs).toContain('deep');
    expect(body.paragraphs.join(' ')).not.toContain('garbage');
  });

  it('has no html for a plain message', async () => {
    const body = await parse(raw(`Content-Type: text/plain\n\nhi\n`));
    expect(body.html).toBeUndefined();
    expect(body.paragraphs).toEqual(['hi']);
  });

  describe('sender', () => {
    let keys: Record<string, readonly string[]>;
    let signing: CryptoKeyPair;

    beforeAll(async () => {
      signing = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const publicKey = new Uint8Array(
        await crypto.subtle.exportKey('raw', signing.publicKey),
      ).toBase64();
      keys = { 's._domainkey.news.example': [`v=DKIM1; k=ed25519; p=${publicKey}`] };
    });

    const MESSAGE = [
      'From: News <digest@news.example>',
      'To: me@x.example',
      'Subject: hi',
      'Date: Fri, 30 Oct 2026 08:00:00 +0000',
      'Content-Type: text/plain',
      '',
      'hi',
      '',
    ].join('\r\n');

    const signed = (domain = 'news.example') =>
      signMessage(MESSAGE, {
        key: signing.privateKey,
        algorithm: 'ed25519-sha256',
        domain,
        selector: 's',
      });
    const lookup: TxtLookup = async name => keys[name] ?? [];

    it('keeps the From a signature vouches for', async () => {
      const body = await parse(new TextEncoder().encode(await signed()), lookup);
      expect(body.verifiedFrom).toBe('digest@news.example');
      expect(body.paragraphs).toEqual(['hi']);
    });

    it('keeps none for a message nobody signed, or one signed for another domain', async () => {
      expect((await parse(new TextEncoder().encode(MESSAGE), lookup)).verifiedFrom).toBeNull();
      const other = await signed('elsewhere.example');
      expect((await parse(new TextEncoder().encode(other), lookup)).verifiedFrom).toBeNull();
    });

    it('keeps none when the key could not be looked up', async () => {
      const body = await parse(new TextEncoder().encode(await signed()), async () => null);
      expect(body.verifiedFrom).toBeNull();
    });
  });
});

describe('htmlToText', () => {
  it('reads a frameset document from its noframes fallback, as Document.body does', () => {
    expect(htmlToText('<frameset><noframes>Fallback</noframes></frameset>')).toBe('Fallback');
  });

  /** Inline SVG carries CSS and tooltips, which are never the message's text. */
  const svg = '<svg><style>.a{fill:red}</style><title>Logo</title><text>Hello</text></svg>';

  it('leaves out what is never text inside SVG, as in HTML', () => {
    expect(htmlToText(`<p>${svg} there</p>`).trim()).toBe('Hello there');
  });

  it('leaves the same out past the nesting depth, where it walks the tree flat', () => {
    const deep = `${'<span>'.repeat(200)}${svg} there${'</span>'.repeat(200)}`;
    expect(htmlToText(deep).trim()).toBe('Hello there');
  });
});

describe('fetchBody size boundary', () => {
  const unusedRun = (async () => {
    throw new Error('run should not be called');
  }) as Parameters<typeof fetchBody>[0];

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'refuses an invalid advertised size (%s) before connecting',
    async size => {
      await expect(fetchBody(unusedRun, 'INBOX', 1, size, noKeys)).resolves.toEqual({
        ok: false,
        error: { kind: 'error', detail: 'Message size is unavailable' },
      });
    },
  );

  it('refuses an oversized message before connecting', async () => {
    await expect(
      fetchBody(unusedRun, 'INBOX', 1, DEFAULT_MAX_LITERAL_BYTES + 1, noKeys),
    ).resolves.toEqual({
      ok: false,
      error: { kind: 'error', detail: 'Message is too large to open safely' },
    });
  });
});

describe('fetchBodyAt', () => {
  const message = raw('From: a@x\nSubject: Hi\n\nHello there.');
  const fetched: string[] = [];
  const runFor =
    (served: Uint8Array): Parameters<typeof fetchBodyAt>[0] =>
    task =>
      task.run({
        ...stubImapClient({
          fetchRaw: async uid => {
            fetched.push(`fetch ${uid}`);
            return { ok: true, value: served };
          },
        }),
        ensureSelected: async name => {
          fetched.push(`select ${name}`);
          return {
            ok: true,
            value: {
              name,
              exists: 1,
              uidValidity: 7,
              uidNext: 2,
              flags: [],
              permanentFlags: [],
              readOnly: false,
            },
          };
        },
      });
  const run = runFor(message);
  const synced = async () => {
    const folder = memoryMailCache().folder('archive');
    await folder.putSync({ name: 'Archive', uidValidity: 7, lastUid: 1, complete: true });
    return folder;
  };

  it('fetches the copy from its mailbox and caches a small body', async () => {
    fetched.length = 0;
    const folder = await synced();
    const res = await fetchBodyAt(
      run,
      folder,
      { folder: 'archive', uidValidity: 7, uid: 1 },
      100,
      noKeys,
    );
    expect(res).toMatchObject({ ok: true, value: { paragraphs: ['Hello there.'] } });
    expect(fetched).toEqual(['select Archive', 'fetch 1']);
    expect(await folder.getBody(1)).toMatchObject({ paragraphs: ['Hello there.'] });
  });

  it('looks the key up after the task has given the connection back', async () => {
    const key = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const signedMessage = await signMessage(
      [
        'From: a@x.example',
        'To: me@y.example',
        'Subject: Hi',
        'Date: Fri, 30 Oct 2026 08:00:00 +0000',
        '',
        'Hello.',
        '',
      ].join('\r\n'),
      { key: key.privateKey, algorithm: 'ed25519-sha256', domain: 'x.example', selector: 's' },
    );
    const events: string[] = [];
    const finishing: Parameters<typeof fetchBodyAt>[0] = async task => {
      const res = await runFor(new TextEncoder().encode(signedMessage))(task);
      events.push('task settled');
      return res;
    };
    await fetchBodyAt(
      finishing,
      await synced(),
      { folder: 'archive', uidValidity: 7, uid: 1 },
      100,
      async () => {
        events.push('lookup');
        return [];
      },
    );
    expect(events).toEqual(['task settled', 'lookup']);
  });

  it('keeps nothing once the cache it was fetched for has gone stale', async () => {
    const folder = await synced();
    const res = await fetchBodyAt(
      run,
      folder,
      { folder: 'archive', uidValidity: 7, uid: 1 },
      100,
      noKeys,
      () => true,
    );
    expect(res.ok).toBe(true);
    expect(await folder.getBody(1)).toBeNull();
  });

  it('leaves a large body out of the cache', async () => {
    const folder = await synced();
    await fetchBodyAt(
      run,
      folder,
      { folder: 'archive', uidValidity: 7, uid: 1 },
      MAX_CACHED_BODY_BYTES + 1,
      noKeys,
    );
    expect(await folder.getBody(1)).toBeNull();
  });

  it('refuses a copy whose folder was renumbered, without fetching', async () => {
    fetched.length = 0;
    const res = await fetchBodyAt(
      run,
      await synced(),
      { folder: 'archive', uidValidity: 6, uid: 1 },
      100,
      noKeys,
    );
    expect(res).toEqual({
      ok: false,
      error: { kind: 'error', detail: 'archive was renumbered; reopen the conversation' },
    });
    expect(fetched).toEqual([]);
  });
});
