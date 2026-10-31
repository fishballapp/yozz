import { KeyObject } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SignOptions, signMessage } from '../testing/dkim-signer.ts';
import { type TxtLookup, verifySender } from './dkim.ts';

const MESSAGE = [
  'Received: from mx.example.com by mx.receiver.example',
  'From: Joe SixPack <joe@example.com>',
  'To: Suzie Q <suzie@receiver.example>',
  'Subject: Is dinner ready?',
  'Date: Fri, 11 Jul 2003 21:00:37 -0700',
  'Message-ID: <20030712040037.46341.5F8J@example.com>',
  '',
  'Hi.',
  '',
  'We lost the game.  Are you hungry yet?  ',
  '',
  'Joe.',
  '',
  '',
].join('\r\n');

const bytes = (text: string) => new TextEncoder().encode(text);

/** A lookup over a fixed zone, counting what it is asked. */
const zone = (records: Readonly<Record<string, readonly string[] | null>>) => {
  const asked: string[] = [];
  const lookup: TxtLookup = async name => {
    asked.push(name);
    return records[name] ?? [];
  };
  return { lookup, asked };
};

const RSA_PARAMS = {
  name: 'RSASSA-PKCS1-v1_5',
  publicExponent: new Uint8Array([1, 0, 1]),
} as const;

const rsaKeys = (modulusLength: number, hash: 'SHA-256' | 'SHA-1' = 'SHA-256') =>
  crypto.subtle.generateKey({ ...RSA_PARAMS, modulusLength, hash }, true, ['sign', 'verify']);

const spki = async (key: CryptoKey) =>
  new Uint8Array(await crypto.subtle.exportKey('spki', key)).toBase64();

let rsa: CryptoKeyPair;
let ed25519: CryptoKeyPair;
/** `rsa._domainkey.example.com` and `ed._domainkey.example.com`. */
let keys: Record<string, readonly string[]>;

beforeAll(async () => {
  rsa = await rsaKeys(2048);
  ed25519 = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const rawEd25519 = new Uint8Array(
    await crypto.subtle.exportKey('raw', ed25519.publicKey),
  ).toBase64();
  keys = {
    'rsa._domainkey.example.com': [`v=DKIM1; k=rsa; p=${await spki(rsa.publicKey)}`],
    'ed._domainkey.example.com': [`v=DKIM1; k=ed25519; p=${rawEd25519}`],
  };
});

const signRsa = (message: string, options: Partial<SignOptions> = {}) =>
  signMessage(message, {
    key: rsa.privateKey,
    algorithm: 'rsa-sha256',
    domain: 'example.com',
    selector: 'rsa',
    ...options,
  });

const verify = (message: string, records = keys) =>
  verifySender(bytes(message), zone(records).lookup);

const VERIFIED = { status: 'verified', from: 'joe@example.com', domain: 'example.com' };

const unverified = (reason: string) => ({ status: 'unverified', reason });

describe('verifySender: canonicalisation', () => {
  for (const header of ['simple', 'relaxed'] as const) {
    for (const body of ['simple', 'relaxed'] as const) {
      it(`verifies ${header}/${body} with RSA and Ed25519`, async () => {
        expect(await verify(await signRsa(MESSAGE, { canonicalization: [header, body] }))).toEqual(
          VERIFIED,
        );
        const signed = await signMessage(MESSAGE, {
          key: ed25519.privateKey,
          algorithm: 'ed25519-sha256',
          domain: 'example.com',
          selector: 'ed',
          canonicalization: [header, body],
        });
        expect(await verify(signed)).toEqual(VERIFIED);
      });
    }
  }

  it('relaxed survives what relays do to whitespace and folding', async () => {
    const signed = await signRsa(MESSAGE);
    const relayed = signed
      .replace('Subject: Is dinner ready?', 'subject:   Is dinner\r\n\tready?  ')
      .replace('Are you hungry yet?  ', 'Are you\t\thungry yet?');
    expect(await verify(relayed)).toEqual(VERIFIED);
  });

  it('simple does not', async () => {
    const signed = await signRsa(MESSAGE, { canonicalization: ['simple', 'simple'] });
    expect(await verify(signed.replace('Subject: Is', 'Subject:  Is'))).toEqual(
      unverified('bad-signature'),
    );
    expect(await verify(signed.replace('game.  Are', 'game. Are'))).toEqual(
      unverified('body-changed'),
    );
  });

  it('reads a message whose line ends a store rewrote to LF', async () => {
    const signed = await signRsa(MESSAGE, { canonicalization: ['simple', 'simple'] });
    expect(await verify(signed.replaceAll('\r\n', '\n'))).toEqual(VERIFIED);
  });
});

describe('verifySender: what the signature covers', () => {
  it('refuses a body altered by one byte', async () => {
    const signed = await signRsa(MESSAGE);
    expect(await verify(signed.replace('Joe.', 'Joe!'))).toEqual(unverified('body-changed'));
  });

  it('refuses a body with text appended', async () => {
    const signed = await signRsa(MESSAGE);
    expect(await verify(`${signed}P.S. send money\r\n`)).toEqual(unverified('body-changed'));
  });

  it('refuses a changed signed header', async () => {
    const signed = await signRsa(MESSAGE);
    expect(await verify(signed.replace('dinner', 'lunch'))).toEqual(unverified('bad-signature'));
  });

  it('is indifferent to the order of different headers, which h= fixes', async () => {
    const signed = await signRsa(MESSAGE);
    const reordered = signed.replace(
      'To: Suzie Q <suzie@receiver.example>\r\nSubject: Is dinner ready?',
      'Subject: Is dinner ready?\r\nTo: Suzie Q <suzie@receiver.example>',
    );
    expect(await verify(reordered)).toEqual(VERIFIED);
  });

  it('refuses a second To added below the signed one, which bottom-up picks instead', async () => {
    const signed = await signRsa(MESSAGE);
    const added = signed.replace('Date:', 'To: everyone@receiver.example\r\nDate:');
    expect(await verify(added)).toEqual(unverified('bad-signature'));
  });

  it('refuses an unsigned Subject, Reply-To or second MIME field prepended to a genuine message', async () => {
    const message = MESSAGE.replace(
      'Date:',
      'Content-Type: text/plain\r\nContent-Transfer-Encoding: 7bit\r\nDate:',
    );
    const signed = await signRsa(message);
    for (const field of [
      'Subject: URGENT: your account is suspended',
      'Reply-To: attacker@evil.example',
      'Content-Type: text/html',
      'Content-Transfer-Encoding: base64',
    ]) {
      expect(await verify(`${field}\r\n${signed}`)).toEqual(unverified('unsigned-header'));
    }
  });

  it('accepts one Content-Type the signature leaves out, as Gmail does, but not a second', async () => {
    const message = MESSAGE.replace('Date:', 'Content-Type: text/plain\r\nDate:');
    const signed = await signRsa(message);
    expect(await verify(signed)).toEqual(VERIFIED);
    expect(await verify(`Content-Type: text/html\r\n${signed}`)).toEqual(
      unverified('unsigned-header'),
    );
  });

  it('refuses a Reply-To the signature leaves out', async () => {
    const message = MESSAGE.replace('Date:', 'Reply-To: help@example.com\r\nDate:');
    expect(await verify(await signRsa(message))).toEqual(unverified('unsigned-header'));
  });

  it('accepts an added header h= does not name', async () => {
    const signed = await signRsa(MESSAGE);
    expect(await verify(`X-Spam-Score: 0.1\r\n${signed}`)).toEqual(VERIFIED);
  });

  it('refuses a From added to an oversigned message', async () => {
    const signed = await signRsa(MESSAGE, { headers: ['from', 'from', 'to', 'subject'] });
    expect(await verify(signed)).toEqual(VERIFIED);
    // A second From is not one author anyway; the signature refuses it too, as the next test shows.
    expect(await verify(signed.replace('To:', 'From: ceo@example.com\r\nTo:'))).toEqual(
      unverified('from-not-single'),
    );
  });

  it('refuses a header added where oversigning promised none', async () => {
    const signed = await signRsa(MESSAGE, { headers: ['from', 'to', 'subject', 'reply-to'] });
    expect(await verify(signed)).toEqual(VERIFIED);
    expect(await verify(signed.replace('To:', 'Reply-To: thief@evil.example\r\nTo:'))).toEqual(
      unverified('bad-signature'),
    );
  });

  it('refuses a signature that leaves From out of h=', async () => {
    const signed = await signRsa(MESSAGE, { headers: ['to', 'subject'] });
    expect(await verify(signed)).toEqual(unverified('from-not-signed'));
  });

  it('refuses l= with text appended after the signed length', async () => {
    const length = 'Hi.\r\n\r\nWe lost the game. Are you hungry yet?\r\n\r\nJoe.\r\n'.length;
    const signed = await signRsa(MESSAGE, { bodyLength: length });
    expect(await verify(signed)).toEqual(VERIFIED);
    expect(await verify(`${signed}Click here: https://evil.example\r\n`)).toEqual(
      unverified('partial-body'),
    );
  });

  it('refuses l= longer than the body', async () => {
    const signed = await signRsa(MESSAGE, { bodyLength: 10_000 });
    expect(await verify(signed)).toEqual(unverified('partial-body'));
  });
});

describe('verifySender: alignment', () => {
  it('refuses d= on another organisational domain, without asking DNS', async () => {
    const signed = await signRsa(MESSAGE, { domain: 'mailer.example.net' });
    const { lookup, asked } = zone({
      'rsa._domainkey.mailer.example.net': keys['rsa._domainkey.example.com'] ?? [],
    });
    expect(await verifySender(bytes(signed), lookup)).toEqual(unverified('not-aligned'));
    expect(asked).toEqual([]);
  });

  it('refuses two subdomains of a private suffix as one organisation', async () => {
    const message = MESSAGE.replace('joe@example.com', 'joe@victim.github.io');
    const signed = await signRsa(message, { domain: 'evil.github.io' });
    const records = { 'rsa._domainkey.evil.github.io': keys['rsa._domainkey.example.com'] ?? [] };
    expect(await verify(signed, records)).toEqual(unverified('not-aligned'));
  });

  it('aligns a subdomain signature with the parent From, and the reverse', async () => {
    const records = { 'rsa._domainkey.mail.example.com': keys['rsa._domainkey.example.com'] ?? [] };
    const signed = await signRsa(MESSAGE, { domain: 'mail.example.com' });
    expect(await verify(signed, records)).toEqual({ ...VERIFIED, domain: 'mail.example.com' });
    const fromSubdomain = MESSAGE.replace('joe@example.com', 'joe@news.example.com');
    expect(await verify(await signRsa(fromSubdomain))).toEqual({
      ...VERIFIED,
      from: 'joe@news.example.com',
    });
  });

  it('under a t=s key, aligns only the exact From domain', async () => {
    const strict = {
      'rsa._domainkey.example.com': [`${keys['rsa._domainkey.example.com']?.[0]}; t=s`],
    };
    expect(await verify(await signRsa(MESSAGE), strict)).toEqual(VERIFIED);
    const fromSubdomain = MESSAGE.replace('joe@example.com', 'joe@news.example.com');
    expect(await verify(await signRsa(fromSubdomain), strict)).toEqual(unverified('not-aligned'));
  });

  it('refuses a From that is not one mailbox', async () => {
    const signed = await signRsa(MESSAGE);
    expect(
      await verify(signed.replace('<joe@example.com>', '<joe@example.com>, ann@example.com')),
    ).toEqual(unverified('from-not-single'));
    expect(await verify(signed.replace('From: Joe SixPack <joe@example.com>\r\n', ''))).toEqual(
      unverified('from-not-single'),
    );
  });
});

describe('verifySender: keys', () => {
  it('refuses a revoked key', async () => {
    const revoked = { 'rsa._domainkey.example.com': ['v=DKIM1; k=rsa; p='] };
    expect(await verify(await signRsa(MESSAGE), revoked)).toEqual(unverified('key-revoked'));
  });

  it('refuses when DNS fails, has nothing, or throws', async () => {
    const signed = bytes(await signRsa(MESSAGE));
    expect(await verifySender(signed, async () => null)).toEqual(unverified('key-unavailable'));
    expect(await verifySender(signed, async () => [])).toEqual(unverified('key-unavailable'));
    expect(await verifySender(signed, async () => ['v=spf1 -all'])).toEqual(
      unverified('key-unavailable'),
    );
    expect(
      await verifySender(signed, () => {
        throw new Error('offline');
      }),
    ).toEqual(unverified('key-unavailable'));
  });

  it('refuses rsa-sha1 even when the signature is good', async () => {
    const sha1 = await rsaKeys(2048, 'SHA-1');
    const signed = await signRsa(MESSAGE, { key: sha1.privateKey, algorithm: 'rsa-sha1' });
    const records = { 'rsa._domainkey.example.com': [`v=DKIM1; p=${await spki(sha1.publicKey)}`] };
    expect(await verify(signed, records)).toEqual(unverified('weak-algorithm'));
  });

  it('refuses an RSA key under 1024 bits', async () => {
    const short = await rsaKeys(768);
    const signed = await signRsa(MESSAGE, { key: short.privateKey });
    const records = { 'rsa._domainkey.example.com': [`v=DKIM1; p=${await spki(short.publicKey)}`] };
    expect(await verify(signed, records)).toEqual(unverified('weak-key'));
  });

  it('accepts a bare PKCS#1 RSA key', async () => {
    const pkcs1 = KeyObject.from(rsa.publicKey).export({ type: 'pkcs1', format: 'der' }).toBase64();
    const records = { 'rsa._domainkey.example.com': [`v=DKIM1; k=rsa; p=${pkcs1}`] };
    expect(await verify(await signRsa(MESSAGE), records)).toEqual(VERIFIED);
  });

  it('honours the key record’s k=, h=, s= and v=', async () => {
    const signed = await signRsa(MESSAGE);
    const withKey = (record: (p: string) => string) => ({
      'rsa._domainkey.example.com': [
        record(keys['rsa._domainkey.example.com']?.[0]?.split('p=')[1] ?? ''),
      ],
    });
    expect(
      await verify(
        signed,
        withKey(p => `p=${p}`),
      ),
    ).toEqual(VERIFIED);
    expect(
      await verify(
        signed,
        withKey(p => `h=sha1:sha256; s=email; p=${p}`),
      ),
    ).toEqual(VERIFIED);
    expect(
      await verify(
        signed,
        withKey(p => `k=ed25519; p=${p}`),
      ),
    ).toEqual(unverified('key-invalid'));
    expect(
      await verify(
        signed,
        withKey(p => `h=sha1; p=${p}`),
      ),
    ).toEqual(unverified('key-invalid'));
    expect(
      await verify(
        signed,
        withKey(p => `s=other; p=${p}`),
      ),
    ).toEqual(unverified('key-invalid'));
    expect(
      await verify(
        signed,
        withKey(p => `v=DKIM2; p=${p}`),
      ),
    ).toEqual(unverified('key-unavailable'));
    expect(
      await verify(
        signed,
        withKey(p => `p=${p.slice(10)}`),
      ),
    ).toEqual(unverified('key-invalid'));
  });

  it('refuses a signature made by another key', async () => {
    const other = await rsaKeys(2048);
    expect(await verify(await signRsa(MESSAGE, { key: other.privateKey }))).toEqual(
      unverified('bad-signature'),
    );
  });

  it('accepts a key whose record is split into strings the lookup joined', async () => {
    const record = keys['rsa._domainkey.example.com']?.[0] ?? '';
    const parts = record.match(/.{1,255}/g) ?? [];
    expect(parts.length).toBeGreaterThan(1);
    expect(
      await verify(await signRsa(MESSAGE), { 'rsa._domainkey.example.com': [parts.join('')] }),
    ).toEqual(VERIFIED);
  });
});

describe('verifySender: several signatures', () => {
  it('verifies the second when the first is bad', async () => {
    const good = await signRsa(MESSAGE);
    const other = await rsaKeys(2048);
    const bad = await signRsa(good, { key: other.privateKey });
    expect(await verify(bad)).toEqual(VERIFIED);
  });

  it('looks at no more than five', async () => {
    const other = await rsaKeys(2048);
    const signed = await Array.from({ length: 7 }).reduce<Promise<string>>(
      async (message, _, index) =>
        signRsa(await message, { key: other.privateKey, selector: `s${index}` }),
      Promise.resolve(MESSAGE),
    );
    const records = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [
        `s${index}._domainkey.example.com`,
        keys['rsa._domainkey.example.com'] ?? [],
      ]),
    );
    const { lookup, asked } = zone(records);
    expect(await verifySender(bytes(signed), lookup)).toEqual(unverified('bad-signature'));
    expect(asked).toHaveLength(5);
  });
});

describe('verifySender: hostile input', () => {
  it('refuses a missing signature', async () => {
    expect(await verify(MESSAGE)).toEqual(unverified('no-signature'));
  });

  it('refuses a CR CR LF line, where postal-mime ends the headers and renders what follows', async () => {
    const signed = await signRsa(MESSAGE);
    const smuggled = `X-Mailer: x\r\n\r\r\nX-A: <b>Your invoice is overdue</b><!--\r\n${signed}`;
    expect(await verify(smuggled.replace('\r\r\n', ''))).toEqual(VERIFIED);
    expect(await verify(smuggled)).toEqual(unverified('malformed-headers'));
  });

  it('refuses a From another parser reads and a strict one would drop', async () => {
    const signed = await signRsa(MESSAGE);
    for (const prefix of [
      'From\r\n : ceo@victim.example\r\n',
      ' From: ceo@victim.example\r\n',
      'junk\r\n',
    ]) {
      expect(await verify(prefix + signed)).toEqual(unverified('malformed-headers'));
    }
  });

  it('refuses a From whose domain is not a plain host name', async () => {
    // postal-mime reads the address as `ceo@victim.example(@evil.example/)`, and a URL-minded
    // host extraction would cut its domain down to evil.example.
    const message = MESSAGE.replace(
      'Joe SixPack <joe@example.com>',
      'CEO <ceo@victim.example(@evil.example/)>',
    );
    const signed = await signRsa(message, { domain: 'evil.example' });
    const records = { 'rsa._domainkey.evil.example': keys['rsa._domainkey.example.com'] ?? [] };
    expect(await verify(signed, records)).toEqual(unverified('from-not-single'));
  });

  it('reads a long whitespace run in a tag value in linear time', async () => {
    const signed = await signRsa(MESSAGE, { tags: [`z=a${' '.repeat(200_000)}x`] });
    const started = performance.now();
    expect(await verify(signed)).toEqual(VERIFIED);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('does not take an algorithm from the object prototype', async () => {
    const signed = await signRsa(MESSAGE);
    expect(await verify(signed.replace('a=rsa-sha256', 'a=toString'))).toEqual(
      unverified('unsupported'),
    );
  });

  it('refuses an l= that is not plain digits', async () => {
    // Number('0x10') is 16 and Number('') is 0: each would pass as the body's exact length.
    const sixteen = MESSAGE.replace(/\r\n\r\nHi\.[\s\S]*$/, '\r\n\r\n0123456789abcd\r\n');
    expect(await verify(await signRsa(sixteen, { tags: ['l=16'] }))).toEqual(VERIFIED);
    expect(await verify(await signRsa(sixteen, { tags: ['l=0x10'] }))).toEqual(
      unverified('malformed'),
    );
    const empty = MESSAGE.replace(/\r\n\r\nHi\.[\s\S]*$/, '\r\n\r\n');
    expect(await verify(await signRsa(empty, { tags: ['l='] }))).toEqual(unverified('malformed'));
  });

  it('refuses malformed and unsupported signatures without throwing', async () => {
    const signed = await signRsa(MESSAGE);
    const cases: [string, string][] = [
      [signed.replace('v=1', 'v=2'), 'malformed'],
      [signed.replace('; s=rsa;', '; s=rsa; s=other;'), 'malformed'],
      [signed.replace('d=example.com', 'd=exa mple.com'), 'malformed'],
      [signed.replace('bh=', 'bh=!!'), 'malformed'],
      [signed.replace('a=rsa-sha256', 'a=rsa-sha512'), 'unsupported'],
      [signed.replace('c=relaxed/relaxed', 'c=relaxed/fancy'), 'unsupported'],
      ['DKIM-Signature: ;;;\r\nFrom: a@example.com\r\n\r\n', 'malformed'],
      ['DKIM-Signature: =\r\nFrom: a@example.com\r\n\r\n', 'malformed'],
    ];
    for (const [message, reason] of cases)
      expect(await verify(message)).toEqual(unverified(reason));
  });

  it('does not fail an expired x=', async () => {
    const signed = await signRsa(MESSAGE, { tags: ['x=1700000001'] });
    expect(await verify(signed)).toEqual(VERIFIED);
  });

  it('never throws on a damaged message', async () => {
    const signed = bytes(await signRsa(MESSAGE));
    for (let index = 0; index < signed.length; index += 3) {
      const damaged = new Uint8Array(signed);
      damaged[index] = (index * 31) % 256;
      const verdict = await verifySender(damaged, zone(keys).lookup);
      expect(['verified', 'unverified']).toContain(verdict.status);
    }
    const noise = crypto.getRandomValues(new Uint8Array(4096));
    expect((await verifySender(noise, zone(keys).lookup)).status).toBe('unverified');
  });
});

describe('verifySender: independent vectors', () => {
  // RFC 8463 Appendix A, verbatim: one message signed by both algorithms, keys from §A.2.
  const RFC_8463_KEYS = {
    'brisbane._domainkey.football.example.com': [
      'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
    ],
    'test._domainkey.football.example.com': [
      'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR' +
        'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC' +
        'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3' +
        'Ip3G+2kryOTIKT+l/K4w3QIDAQAB',
    ],
  };
  const ED25519_SIGNATURE = [
    'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
    ' d=football.example.com; i=@football.example.com;',
    ' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
    ' subject : date : message-id : from : subject : date;',
    ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
    ' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
    ' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
  ];
  const RSA_SIGNATURE = [
    'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
    ' d=football.example.com; i=@football.example.com;',
    ' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
    ' date : message-id : from : subject : date;',
    ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
    ' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
    ' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
    ' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
  ];
  const REST = [
    'From: Joe SixPack <joe@football.example.com>',
    'To: Suzie Q <suzie@shopping.example.net>',
    'Subject: Is dinner ready?',
    'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
    'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
    '',
    'Hi.',
    '',
    'We lost the game.  Are you hungry yet?',
    '',
    'Joe.',
    '',
    '',
  ];
  const RFC_VERIFIED = {
    status: 'verified',
    from: 'joe@football.example.com',
    domain: 'football.example.com',
  };
  const message = (...lines: string[]) => bytes(lines.join('\r\n'));

  it('RFC 8463: the Ed25519 signature', async () => {
    const { lookup, asked } = zone(RFC_8463_KEYS);
    expect(await verifySender(message(...ED25519_SIGNATURE, ...REST), lookup)).toEqual(
      RFC_VERIFIED,
    );
    expect(asked).toEqual(['brisbane._domainkey.football.example.com']);
  });

  it('RFC 8463: the RSA signature', async () => {
    const { lookup } = zone(RFC_8463_KEYS);
    expect(await verifySender(message(...RSA_SIGNATURE, ...REST), lookup)).toEqual(RFC_VERIFIED);
  });

  it('RFC 8463: both, as published', async () => {
    const { lookup } = zone(RFC_8463_KEYS);
    expect(
      await verifySender(message(...ED25519_SIGNATURE, ...RSA_SIGNATURE, ...REST), lookup),
    ).toEqual(RFC_VERIFIED);
  });

  it('RFC 8463: an altered copy fails both', async () => {
    const { lookup } = zone(RFC_8463_KEYS);
    const altered = REST.map(line => line.replace('dinner', 'lunch'));
    expect(
      await verifySender(message(...ED25519_SIGNATURE, ...RSA_SIGNATURE, ...altered), lookup),
    ).toEqual(unverified('bad-signature'));
  });
  // Signed by another implementation (mailauth 8.0.4, `dkimSign`): simple/simple RSA and
  // relaxed/simple Ed25519, From on a subdomain of d=, h= written with spaces after the colons.
  const MAILAUTH_KEYS = {
    'mailauth._domainkey.example.org': [
      'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC75ivySCOtLbxJ0RduFW14lkQyewoAvsPWS9U4rbENqWPjkx0toSf3suQydcZAmdcTywVVaZ+Q/lJr9ZQch4vIZMfDcQ5WQP6K90dvERBBamJi2QNRU6xZEA8i6so43yhR0PF5fZQES6LIxfufxBn5wf56Urz/Cc6NOS7PJYcxBQIDAQAB',
    ],
    'mailauth-ed._domainkey.example.org': [
      'v=DKIM1; k=ed25519; p=kCKNoXJzW0ZNFXCfdCahEHbLjhncV2GioO5kg1atCNg=',
    ],
  };
  const MAILAUTH_RSA = [
    'DKIM-Signature: v=1; a=rsa-sha256; c=simple/simple; d=example.org;',
    ' h=Content-Type: MIME-Version: Message-ID: Date: Subject: To: From;',
    ' q=dns/txt; s=mailauth; t=1672653601;',
    ' bh=cUFMtHMfzGT41lo69JUo/yuHVeZBxQWclYWvAqt7m3E=;',
    ' b=H/7VRNqqOvF4xk/UGRI5Vjh/jw6+SqFCHGUSTB6E9JcE0b6KOJhthgNzA3PtH6itfsKEiGDLO',
    ' 66uedKt4Xv28UQYXkeJW+Mi4B4daXPRxHOUUYL+fzKsEsewVDIViR5DRKSQIaX5TmKtMU7OIg03',
    ' dYZLGn8vHS/UWTfDlj6wyL8=',
  ];
  const MAILAUTH_ED25519 = [
    'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/simple; d=example.org;',
    ' h=Content-Type: MIME-Version: Message-ID: Date: Subject: To: From;',
    ' q=dns/txt; s=mailauth-ed; t=1672653601;',
    ' bh=cUFMtHMfzGT41lo69JUo/yuHVeZBxQWclYWvAqt7m3E=;',
    ' b=rZP1l1RR91GGzgGFAjqFIUyATEaNADVyyE8015740malXP29ZhVOcjc0C7xqIgLRkPP2HzzjW',
    ' cismvFXm4NTCA==',
  ];
  const MAILAUTH_MESSAGE = [
    'From: "Ann Example" <ann@mail.example.org>',
    'To: bob@example.net',
    'Subject:  Lunch\t on   Friday? ',
    'Date: Mon, 02 Jan 2023 10:00:00 +0000',
    'Message-ID: <lunch-1@mail.example.org>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Hi Bob,',
    '',
    '  Are you free \t on Friday?   ',
    '',
    'Ann',
    '',
    '',
    '',
  ];
  const MAILAUTH_VERIFIED = {
    status: 'verified',
    from: 'ann@mail.example.org',
    domain: 'example.org',
  };

  it('mailauth: simple/simple RSA', async () => {
    const { lookup } = zone(MAILAUTH_KEYS);
    expect(await verifySender(message(...MAILAUTH_RSA, ...MAILAUTH_MESSAGE), lookup)).toEqual(
      MAILAUTH_VERIFIED,
    );
  });

  it('mailauth: relaxed/simple Ed25519', async () => {
    const { lookup } = zone(MAILAUTH_KEYS);
    expect(await verifySender(message(...MAILAUTH_ED25519, ...MAILAUTH_MESSAGE), lookup)).toEqual(
      MAILAUTH_VERIFIED,
    );
  });

  it('mailauth: simple refuses the whitespace relaxed forgives', async () => {
    const { lookup } = zone(MAILAUTH_KEYS);
    const respaced = MAILAUTH_MESSAGE.map(line =>
      line.replace('Subject:  Lunch', 'Subject: Lunch'),
    );
    expect(await verifySender(message(...MAILAUTH_RSA, ...respaced), lookup)).toEqual(
      unverified('bad-signature'),
    );
    expect(await verifySender(message(...MAILAUTH_ED25519, ...respaced), lookup)).toEqual(
      MAILAUTH_VERIFIED,
    );
  });
});
