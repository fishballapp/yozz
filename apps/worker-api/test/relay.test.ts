import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import type { EmailSender } from '../src/email.ts';
import { getWebOrigin } from '../src/env.ts';
import { resolvePublicAddress } from '../src/relay/resolve.ts';
import { isPublicIp, parseRelayTarget } from '../src/relay/target.ts';
import { applyMigrations } from './apply-migrations.ts';

describe('Relay pure target and IP validation', () => {
  describe('parseRelayTarget', () => {
    it('accepts valid hosts on port 993 and 465', () => {
      const imapParams = new URLSearchParams('host=imap.gmail.com&port=993');
      expect(parseRelayTarget(imapParams)).toEqual({
        hostname: 'imap.gmail.com',
        port: 993,
      });

      const smtpParams = new URLSearchParams('host=SMTP.FASTMAIL.COM&port=465');
      expect(parseRelayTarget(smtpParams)).toEqual({
        hostname: 'smtp.fastmail.com',
        port: 465,
      });
    });

    it('rejects disallowed ports 587, 143, 443, 80', () => {
      for (const port of ['587', '143', '443', '80', '25', '995']) {
        const params = new URLSearchParams(`host=imap.gmail.com&port=${port}`);
        expect(parseRelayTarget(params)).toBeNull();
      }
    });

    it('rejects IP literals, localhost, single-label names, empty hosts, and trailing dots', () => {
      const invalidHosts = [
        '127.0.0.1',
        '8.8.8.8',
        '::1',
        '2606:4700::1111',
        'localhost',
        'singlelabel',
        '',
        'imap.gmail.com.',
        '10.0.0.1',
        '192.168.1.1',
      ];
      for (const host of invalidHosts) {
        const params = new URLSearchParams(`host=${encodeURIComponent(host)}&port=993`);
        expect(parseRelayTarget(params)).toBeNull();
      }
    });
  });

  describe('isPublicIp', () => {
    it('accepts public IPv4 and IPv6 addresses', () => {
      expect(isPublicIp('8.8.8.8')).toBe(true);
      expect(isPublicIp('1.1.1.1')).toBe(true);
      expect(isPublicIp('2606:4700::1111')).toBe(true);
      expect(isPublicIp('2001:4860:4860::8888')).toBe(true);
      expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
    });

    it('rejects private, loopback, link-local, multicast, and reserved IP ranges', () => {
      expect(isPublicIp('127.0.0.1')).toBe(false);
      expect(isPublicIp('127.255.255.255')).toBe(false);
      expect(isPublicIp('::1')).toBe(false);

      expect(isPublicIp('10.0.0.1')).toBe(false);
      expect(isPublicIp('10.255.255.255')).toBe(false);
      expect(isPublicIp('172.16.0.1')).toBe(false);
      expect(isPublicIp('172.31.255.255')).toBe(false);
      expect(isPublicIp('192.168.0.1')).toBe(false);
      expect(isPublicIp('192.168.255.255')).toBe(false);

      expect(isPublicIp('169.254.169.254')).toBe(false);
      expect(isPublicIp('fe80::1')).toBe(false);
      expect(isPublicIp('febf::1')).toBe(false);

      expect(isPublicIp('100.64.0.1')).toBe(false);
      expect(isPublicIp('100.127.255.255')).toBe(false);

      expect(isPublicIp('0.0.0.0')).toBe(false);

      expect(isPublicIp('224.0.0.1')).toBe(false);
      expect(isPublicIp('239.255.255.255')).toBe(false);
      expect(isPublicIp('240.0.0.1')).toBe(false);
      expect(isPublicIp('255.255.255.255')).toBe(false);
      expect(isPublicIp('ff00::1')).toBe(false);
      expect(isPublicIp('ff02::1')).toBe(false);

      expect(isPublicIp('fc00::1')).toBe(false);
      expect(isPublicIp('fd12:3456:789a::1')).toBe(false);

      expect(isPublicIp('::')).toBe(false);

      expect(isPublicIp('::ffff:10.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:127.0.0.1')).toBe(false);
      expect(isPublicIp('::ffff:192.168.1.1')).toBe(false);
    });

    it('rejects garbage and malformed strings', () => {
      const garbage = [
        'not an ip',
        '1.2.3',
        '1.2.3.4.5',
        '256.0.0.1',
        '1.2.3.01',
        '',
        '::ffff:999.0.0.1',
        'fe80:::1',
        '2001:xyz::1',
      ];
      for (const str of garbage) {
        expect(isPublicIp(str)).toBe(false);
      }
    });
  });
});

describe('resolvePublicAddress DNS-over-HTTPS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when DNS answers contain only private IP addresses', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { name: 'internal.corp', type: 1, data: '10.0.0.5' },
            { name: 'internal.corp', type: 1, data: '192.168.1.10' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolvePublicAddress('internal.corp');
    expect(result).toBeNull();
  });

  it('returns public address when DNS answers contain a mix of private and public IPs', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [
            { name: 'mixed.example.com', type: 1, data: '10.0.0.5' },
            { name: 'mixed.example.com', type: 1, data: '93.184.216.34' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await resolvePublicAddress('mixed.example.com');
    expect(result).toBe('93.184.216.34');
  });

  it('queries AAAA only when A returns nothing', async () => {
    const fetchedUrls: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const urlStr = url.toString();
      fetchedUrls.push(urlStr);
      if (urlStr.includes('type=AAAA')) {
        return new Response(
          JSON.stringify({
            Status: 0,
            Answer: [{ name: 'v6only.example.com', type: 28, data: '2606:4700::1111' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await resolvePublicAddress('v6only.example.com');
    expect(result).toBe('2606:4700::1111');
    expect(fetchedUrls.length).toBe(2);
    expect(fetchedUrls[0]).toContain('type=A');
    expect(fetchedUrls[1]).toContain('type=AAAA');
  });
});

describe('Relay route HTTP checks', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  const getSessionCookie = async () => {
    let capturedMail: { to: string; url: string; token: string } | null = null;
    const emailSender: EmailSender = async mail => {
      capturedMail = mail;
    };
    const authApp = createApp({ emailSender });

    await authApp.request(
      'http://localhost/api/auth/sign-in/magic-link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: getWebOrigin(env) },
        body: JSON.stringify({ email: 'relayuser@example.com', name: 'Relay User' }),
      },
      env,
    );

    if (!capturedMail) throw new Error('Magic link email not sent');
    const mail: { to: string; url: string; token: string } = capturedMail;
    const verifyRes = await authApp.request(mail.url, { method: 'GET' }, env);
    return verifyRes.headers.get('set-cookie') ?? '';
  };

  it('rejects requests without Upgrade: websocket with 426 UPGRADE_REQUIRED', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/v1/relay?host=imap.gmail.com&port=993',
      {
        method: 'GET',
        headers: { Origin: getWebOrigin(env) },
      },
      env,
    );

    expect(res.status).toBe(426);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('UPGRADE_REQUIRED');
  });

  it('rejects requests with Upgrade but no session with 401 UNAUTHORIZED', async () => {
    const app = createApp();
    const res = await app.request(
      'http://localhost/api/v1/relay?host=imap.gmail.com&port=993',
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Origin: getWebOrigin(env),
        },
      },
      env,
    );

    expect(res.status).toBe(401);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects requests with session but bad Origin with 403 FORBIDDEN', async () => {
    const app = createApp();
    const cookie = await getSessionCookie();

    const res = await app.request(
      'http://localhost/api/v1/relay?host=imap.gmail.com&port=993',
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Origin: 'https://evil.attacker.com',
          Cookie: cookie,
        },
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('rejects requests with session and disallowed port with 400 BAD_REQUEST', async () => {
    const app = createApp();
    const cookie = await getSessionCookie();

    const res = await app.request(
      'http://localhost/api/v1/relay?host=imap.gmail.com&port=587',
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Origin: getWebOrigin(env),
          Cookie: cookie,
        },
      },
      env,
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects non-public target hosts with 403 FORBIDDEN and message', async () => {
    const app = createApp();
    const cookie = await getSessionCookie();

    vi.stubGlobal('fetch', async () => {
      return new Response(
        JSON.stringify({
          Status: 0,
          Answer: [{ name: 'private.internal', type: 1, data: '192.168.1.1' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    try {
      const res = await app.request(
        'http://localhost/api/v1/relay?host=private.internal&port=993',
        {
          method: 'GET',
          headers: {
            Upgrade: 'websocket',
            Origin: getWebOrigin(env),
            Cookie: cookie,
          },
        },
        env,
      );

      expect(res.status).toBe(403);
      const body = await res.json<{ error: { code: string; message: string } }>();
      expect(body.error.code).toBe('FORBIDDEN');
      expect(body.error.message).toBe('Host is not publicly routable');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
