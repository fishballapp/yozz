import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { parseClientConfig, usableServer, usernameForm } from '../src/autoconfig/clientconfig.ts';
import { lookupMailServers, mxDomains, srvTarget } from '../src/autoconfig/lookup.ts';
import { parseHostname } from '../src/relay/target.ts';
import { applyMigrations } from './apply-migrations.ts';

const FASTMAIL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="MessagingEngine">
    <domain>fastmail.com</domain>
    <!-- <incomingServer type="imap"><hostname>commented.out</hostname></incomingServer> -->
    <incomingServer type="imap">
      <hostname>IMAP.fastmail.com</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>OAuth2</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>pop.fastmail.com</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.fastmail.com</hostname>
      <port>465</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`;

const STARTTLS_ONLY_XML = `<clientConfig version="1.1"><emailProvider id="x">
  <incomingServer type="imap"><hostname>imap.x.test</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.x.test</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>`;

const LOCALPART_XML = `<clientConfig version="1.1"><emailProvider id="x">
  <incomingServer type="imap"><hostname>mail.x.test</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
</emailProvider></clientConfig>`;

const dnsJson = (answers: readonly { type: number; data: string }[]) =>
  JSON.stringify({ Status: 0, Answer: answers });

/** A fetch that answers from a URL table; anything unlisted is a 404. */
const fakeFetch =
  (table: Readonly<Record<string, string>>) =>
  async (input: string): Promise<Response> => {
    const body = table[input];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
  };

describe('clientConfig XML', () => {
  it('reads every server block, lowercases hosts and ignores comments', () => {
    const config = parseClientConfig(FASTMAIL_XML);
    expect(config.imap).toEqual([
      { host: 'imap.fastmail.com', port: 993, socketType: 'SSL', username: '%EMAILADDRESS%' },
    ]);
    expect(config.smtp).toEqual([
      { host: 'smtp.fastmail.com', port: 465, socketType: 'SSL', username: '%EMAILADDRESS%' },
    ]);
  });

  it('only a server on the implicit-TLS port is usable', () => {
    const config = parseClientConfig(STARTTLS_ONLY_XML);
    expect(usableServer(config.imap, 993)).toBeNull();
    expect(usableServer(config.smtp, 465)).toBeNull();
  });

  it('reads the username placeholder', () => {
    const local = parseClientConfig(LOCALPART_XML).imap[0];
    if (local === undefined) throw new Error('expected a server');
    expect(usernameForm(local)).toBe('localpart');
    const whole = parseClientConfig(FASTMAIL_XML).imap[0];
    if (whole === undefined) throw new Error('expected a server');
    expect(usernameForm(whole)).toBe('address');
    expect(usernameForm({ host: 'h', port: 993, socketType: 'SSL', username: null })).toBe(
      'address',
    );
  });
});

describe('lookupMailServers', () => {
  it("prefers the provider's own autoconfig over the ISPDB", async () => {
    const found = await lookupMailServers(
      'fastmail.com',
      fakeFetch({
        'https://autoconfig.fastmail.com/mail/config-v1.1.xml': FASTMAIL_XML,
        'https://autoconfig.thunderbird.net/v1.1/fastmail.com': LOCALPART_XML,
      }),
    );
    expect(found).toEqual({
      imap: { host: 'imap.fastmail.com', port: 993 },
      smtp: { host: 'smtp.fastmail.com', port: 465 },
      username: 'address',
      source: 'provider',
      sourceDomain: 'fastmail.com',
    });
  });

  it('falls back to the ISPDB entry of the MX domain for a custom domain', async () => {
    const found = await lookupMailServers(
      'jyu.example',
      fakeFetch({
        'https://cloudflare-dns.com/dns-query?name=jyu.example&type=MX': dnsJson([
          { type: 15, data: '20 in2-smtp.messagingengine.com.' },
          { type: 15, data: '10 in1-smtp.messagingengine.com.' },
        ]),
        'https://autoconfig.thunderbird.net/v1.1/messagingengine.com': FASTMAIL_XML,
      }),
    );
    expect(found?.source).toBe('ispdb');
    expect(found?.sourceDomain).toBe('messagingengine.com');
    expect(found?.imap?.host).toBe('imap.fastmail.com');
  });

  it("tries the MX domain's own autoconfig too, not only its ISPDB entry", async () => {
    const found = await lookupMailServers(
      'northlane.example',
      fakeFetch({
        'https://cloudflare-dns.com/dns-query?name=northlane.example&type=MX': dnsJson([
          { type: 15, data: '0 mx1.forwardemail.net.' },
        ]),
        'https://autoconfig.forwardemail.net/mail/config-v1.1.xml': FASTMAIL_XML,
      }),
    );
    expect(found?.source).toBe('provider');
    expect(found?.sourceDomain).toBe('forwardemail.net');
  });

  it('reads RFC 6186 SRV records when nothing else is published', async () => {
    const found = await lookupMailServers(
      'srv.test',
      fakeFetch({
        'https://cloudflare-dns.com/dns-query?name=_imaps._tcp.srv.test&type=SRV': dnsJson([
          { type: 33, data: '0 1 993 imap.srv.test.' },
        ]),
        'https://cloudflare-dns.com/dns-query?name=_submissions._tcp.srv.test&type=SRV': dnsJson([
          { type: 33, data: '0 1 587 smtp.srv.test.' },
        ]),
      }),
    );
    expect(found).toEqual({
      imap: { host: 'imap.srv.test', port: 993 },
      smtp: null,
      username: 'address',
      source: 'srv',
      sourceDomain: 'srv.test',
    });
  });

  it('is null when a domain publishes only STARTTLS servers', async () => {
    const found = await lookupMailServers(
      'x.test',
      fakeFetch({ 'https://autoconfig.thunderbird.net/v1.1/x.test': STARTTLS_ONLY_XML }),
    );
    expect(found).toBeNull();
  });

  it('derives ISPDB candidates from an MX host', () => {
    expect(mxDomains('in1-smtp.messagingengine.com.')).toEqual(['messagingengine.com']);
    expect(mxDomains('aspmx.l.google.com')).toEqual(['l.google.com', 'google.com']);
    expect(mxDomains('example.com')).toEqual(['example.com']);
  });

  it('picks the SRV target by priority, then weight, and honours the absent sentinel', () => {
    expect(srvTarget(['10 5 993 backup.x.test.', '0 1 993 primary.x.test.'], 993)).toBe(
      'primary.x.test',
    );
    expect(srvTarget(['0 1 993 light.x.test', '0 9 993 heavy.x.test'], 993)).toBe('heavy.x.test');
    expect(srvTarget(['0 0 993 .', '10 0 993 later.x.test'], 993)).toBeNull();
    expect(srvTarget(['0 1 143 starttls.x.test'], 993)).toBeNull();
  });
});

describe('parseHostname', () => {
  it('accepts a public name and rejects literals and single labels', () => {
    expect(parseHostname(' Fastmail.COM ')).toBe('fastmail.com');
    for (const bad of ['1.2.3.4', 'localhost', 'single', 'a.b.', '', 'x.123']) {
      expect(parseHostname(bad)).toBeNull();
    }
  });
});

describe('GET /api/v1/autoconfig', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('needs a session', async () => {
    const res = await createApp().request(
      'http://localhost/api/v1/autoconfig?domain=fastmail.com',
      { headers: { Origin: 'https://yozz.app' } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
