import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { parseAuthenticationResults, senderCheckOf } from './authentication-results.ts';

/** Headers exactly as the reader gets them: a raw message through postal-mime. */
const headersOf = async (head: string) =>
  (await PostalMime.parse(`${head.trim().replace(/\n/g, '\r\n')}\r\n\r\nbody\r\n`)).headers;

// Shapes from real mail (docs/knowledge/authentication-results.md); tokens shortened.
const GMAIL_PASS = `Authentication-Results: mx.google.com;
       dkim=pass header.i=@news.example header.s=s1 header.b=AbCdEf12;
       spf=pass (google.com: domain of bounce@mail.news.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@mail.news.example;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=news.example`;

const MICROSOFT_PASS = `Authentication-Results: spf=pass (sender IP is 192.0.2.1)
 smtp.mailfrom=news.example; dkim=pass (signature was verified)
 header.d=news.example;dmarc=pass action=none
 header.from=news.example;compauth=pass reason=100`;

const YAHOO_PASS = `Authentication-Results: atlas321.free.mail.ne1.yahoo.com;
 dkim=pass header.i=@news.example header.s=s1;
 spf=pass smtp.mailfrom=news.example;
 dmarc=pass(p=REJECT) header.from=news.example;`;

const FASTMAIL_PASS = `Authentication-Results: phl-mx-04.messagingengine.com;
    x-csa=none;
    x-me-sender=none;
    x-ptr=pass smtp.helo=mx-out1001.news.example
    policy.ptr=mx-out1001.news.example
Authentication-Results: phl-mx-04.messagingengine.com;
    bimi=skipped (DMARC Policy is not at enforcement)
Authentication-Results: phl-mx-04.messagingengine.com;
    arc=none (no signatures found)
Authentication-Results: phl-mx-04.messagingengine.com;
    dkim=pass (1024-bit rsa key sha256) header.d=news.example
    header.i=@news.example header.b=SpvuuEcL header.a=rsa-sha256
    header.s=s1;
    dmarc=pass policy.published-domain-policy=none
    policy.published-subdomain-policy=none policy.applied-disposition=none
    policy.evaluated-disposition=none (p=none,sp=none,d=none,d.eval=none)
    policy.policy-from=p header.from=news.example;
    iprev=pass smtp.remote-ip=192.0.2.1 (mx-out1001.news.example);
    spf=pass smtp.mailfrom=privacy@news.example
    smtp.helo=mx-out1001.news.example`;

// From forum excerpts only: the shape iCloud is believed to write, kept to prove it is not trusted yet.
const ICLOUD_PASS = `Authentication-Results: bimi.icloud.com; bimi=none
Authentication-Results: arc.icloud.com; arc=none
Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=news.example
Authentication-Results: dkim-verifier.icloud.com;
	dkim=pass (2048-bit key) header.d=news.example header.i=@news.example header.b=AbCd
Authentication-Results: spf.icloud.com; spf=pass (spf.icloud.com: domain of bounce@news.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@news.example`;

const FROM = 'From: Example News <Digest@News.Example>';
const RECEIVED = 'Received: from mx.news.example (mx.news.example [192.0.2.1]) by receiver';

/** The From the reader shows, from IMAP's ENVELOPE: a parser of its own. */
const SHOWN = 'digest@news.example';

const VERIFIED = { status: 'verified' };
const FAILED = { status: 'failed' };

const verdict = async (host: string, ...blocks: string[]) =>
  senderCheckOf(await headersOf(blocks.join('\n')), host, SHOWN);

describe('senderCheckOf, real provider shapes', () => {
  it.each([
    ['Gmail', 'imap.gmail.com', GMAIL_PASS],
    ['Outlook', 'outlook.office365.com', MICROSOFT_PASS],
    ['Yahoo', 'imap.mail.yahoo.com', YAHOO_PASS],
    ['Fastmail', 'imap.fastmail.com', FASTMAIL_PASS],
  ])(
    '%s: a DMARC pass aligned with From authenticates the From address',
    async (_, host, block) => {
      expect(await verdict(host, block, RECEIVED, FROM)).toEqual(VERIFIED);
    },
  );

  it('matches the IMAP host case-insensitively', async () => {
    expect(await verdict('IMAP.Gmail.com.', GMAIL_PASS, FROM)).toEqual(VERIFIED);
  });

  it('checks nobody on iCloud until its shape is verified, however good the header', async () => {
    expect(await verdict('imap.mail.me.com', ICLOUD_PASS, RECEIVED, FROM)).toEqual({
      status: 'unchecked',
      imapHost: 'imap.mail.me.com',
    });
  });

  it('checks nobody on a provider it does not know, and names the host it could not read', async () => {
    expect(await verdict('mail.example.org', GMAIL_PASS, FROM)).toEqual({
      status: 'unchecked',
      imapHost: 'mail.example.org',
    });
    // Unchecked whatever the headers say: a blind spot, not a verdict.
    expect(await verdict('imap.example.org', RECEIVED, FROM)).toEqual({
      status: 'unchecked',
      imapHost: 'imap.example.org',
    });
  });
});

describe('senderCheckOf, refusals', () => {
  it('refuses a message with no Authentication-Results', async () => {
    expect(await verdict('imap.gmail.com', RECEIVED, FROM)).toEqual(FAILED);
  });

  it('refuses dmarc=fail, none and bestguesspass', async () => {
    for (const result of ['fail', 'none', 'bestguesspass']) {
      const block = GMAIL_PASS.replace('dmarc=pass', `dmarc=${result}`);
      expect(await verdict('imap.gmail.com', block, FROM)).toEqual(FAILED);
    }
  });

  it('refuses a pass for another domain than From', async () => {
    const misaligned = GMAIL_PASS.replace('header.from=news.example', 'header.from=evil.example');
    expect(await verdict('imap.gmail.com', misaligned, FROM)).toEqual(FAILED);
    // A subdomain is another domain here: the header names the domain DMARC evaluated.
    const parent = GMAIL_PASS.replace('header.from=news.example', 'header.from=example');
    expect(await verdict('imap.gmail.com', parent, FROM)).toEqual(FAILED);
  });

  it("refuses a sender's own header carrying the provider's id below the provider's", async () => {
    const forged =
      'Authentication-Results: mx.google.com; dmarc=pass (p=REJECT) header.from=news.example';
    // Gmail writes no dmarc clause for a domain with no record; the forged one below must not fill in.
    const noRecord = GMAIL_PASS.replace(/;\s*dmarc=pass[\s\S]*$/, '');
    expect(await verdict('imap.gmail.com', noRecord, RECEIVED, forged, FROM)).toEqual(FAILED);
    const failed = GMAIL_PASS.replace('dmarc=pass', 'dmarc=fail');
    expect(await verdict('imap.gmail.com', failed, RECEIVED, forged, FROM)).toEqual(FAILED);
  });

  it('refuses a per-method provider whose own run says fail, whatever follows it', async () => {
    const failed = FASTMAIL_PASS.replace('dmarc=pass', 'dmarc=fail');
    const forged =
      'Authentication-Results: phl-mx-04.messagingengine.com; dmarc=pass header.from=news.example';
    expect(await verdict('imap.fastmail.com', failed, forged, RECEIVED, FROM)).toEqual(FAILED);
    // Below someone else's header the provider's id counts for nothing.
    const relay = 'Authentication-Results: relay.example; spf=pass smtp.mailfrom=news.example';
    const withoutDmarc = FASTMAIL_PASS.replace(/dmarc=pass[^;]*;/, '');
    expect(await verdict('imap.fastmail.com', withoutDmarc, relay, forged, RECEIVED, FROM)).toEqual(
      FAILED,
    );
  });

  it("refuses when the provider's header is not on top", async () => {
    const sender = 'Authentication-Results: sender.example; dmarc=pass header.from=news.example';
    expect(await verdict('imap.gmail.com', sender, GMAIL_PASS, FROM)).toEqual(FAILED);
    expect(await verdict('outlook.office365.com', sender, MICROSOFT_PASS, FROM)).toEqual(FAILED);
    expect(await verdict('imap.fastmail.com', sender, FASTMAIL_PASS, FROM)).toEqual(FAILED);
  });

  it('refuses a provider id it does not own', async () => {
    const lookalike = GMAIL_PASS.replace('mx.google.com', 'mx.google.com.evil.example');
    expect(await verdict('imap.gmail.com', lookalike, FROM)).toEqual(FAILED);
    const fastmailLookalike = FASTMAIL_PASS.replaceAll(
      'phl-mx-04.messagingengine.com',
      'mx.messagingengine.com.evil.example',
    );
    expect(await verdict('imap.fastmail.com', fastmailLookalike, FROM)).toEqual(FAILED);
  });

  it('refuses two From headers, or two authors in one', async () => {
    expect(
      await verdict('imap.gmail.com', GMAIL_PASS, FROM, 'From: someone@other.example'),
    ).toEqual(FAILED);
    expect(
      await verdict('imap.gmail.com', GMAIL_PASS, 'From: a@news.example, b@other.example'),
    ).toEqual(FAILED);
    expect(await verdict('imap.gmail.com', GMAIL_PASS)).toEqual(FAILED);
  });

  it('reads nothing hidden in a comment', async () => {
    const hidden =
      'Authentication-Results: mx.google.com; spf=pass (x; dmarc=pass header.from=news.example) smtp.mailfrom=news.example';
    expect(await verdict('imap.gmail.com', hidden, FROM)).toEqual(FAILED);
  });
});

describe('senderCheckOf, what a sender can smuggle in', () => {
  it('refuses a comment that a quoted local part closes early', async () => {
    // A MAIL FROM copied verbatim into the provider's spf comment, carrying a `)` in quotes.
    const smuggled = `Authentication-Results: mx.google.com;
       spf=pass (google.com: domain of "a); dmarc=pass header.from=news.example; ("@evil.example designates 192.0.2.9 as permitted sender) smtp.mailfrom="a"@evil.example;
       dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=news.example`;
    expect(await verdict('imap.gmail.com', smuggled, FROM)).toEqual(FAILED);
  });

  it('refuses a run carrying more than one dmarc result, whichever comes first', async () => {
    const twice = GMAIL_PASS.replace(
      'dmarc=pass',
      'dmarc=pass header.from=news.example; dmarc=fail',
    );
    expect(await verdict('imap.gmail.com', twice, FROM)).toEqual(FAILED);
    const forged =
      'Authentication-Results: phl-mx-04.messagingengine.com; dmarc=pass header.from=news.example';
    expect(await verdict('imap.fastmail.com', FASTMAIL_PASS, forged, FROM)).toEqual(FAILED);
  });

  it('refuses when the From the reader shows is another address than the one authenticated', async () => {
    const headers = await headersOf([GMAIL_PASS, FROM].join('\n'));
    expect(senderCheckOf(headers, 'imap.gmail.com', 'other@news.example')).toEqual(FAILED);
    expect(senderCheckOf(headers, 'imap.gmail.com', 'DIGEST@news.example')).toEqual(VERIFIED);
  });
});

describe('parseAuthenticationResults', () => {
  it('reads the id, methods and properties, quoted values and versions', () => {
    expect(
      parseAuthenticationResults(
        'Mx.Example 1; dkim/1=pass header.d="a;b"; dmarc = pass ( c (nested) ) header.from=x.example',
      ),
    ).toEqual({
      authservId: 'mx.example',
      results: [
        { method: 'dkim', result: 'pass', properties: { 'header.d': 'a;b' } },
        { method: 'dmarc', result: 'pass', properties: { 'header.from': 'x.example' } },
      ],
    });
  });

  it('reads `none` as no results, and refuses what it cannot read', () => {
    expect(parseAuthenticationResults('mx.example; none')).toEqual({
      authservId: 'mx.example',
      results: [],
    });
    expect(parseAuthenticationResults('')).toBeNull();
    expect(parseAuthenticationResults('mx.example junk words; dmarc=pass')).toBeNull();
    expect(parseAuthenticationResults('mx.example; garbage')).toBeNull();
    // A quote inside a comment, or one left open, makes the comment's end unknowable.
    expect(parseAuthenticationResults('mx.example; spf=pass (a "b) c=d')).toBeNull();
    expect(parseAuthenticationResults('mx.example; spf=pass smtp.mailfrom="a')).toBeNull();
  });
});
