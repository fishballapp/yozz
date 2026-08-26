/**
 * SMTP client over a `ByteDuplex` (RFC 5321 + AUTH, RFC 4954). Implicit TLS is the transport's
 * business; this never sees a certificate or a password store. One command in flight at a time,
 * which is all SMTP allows without PIPELINING.
 */
import type { ByteDuplex } from '@yozz.app/tls';
import { createLineReader, readReply, type SmtpReply, type SmtpResult } from './reply.ts';

export type SmtpCapabilities = {
  /** EHLO keywords, upper-cased, e.g. `SIZE`, `8BITMIME`, `SMTPUTF8`, `PIPELINING`. */
  readonly keywords: readonly string[];
  /** SASL mechanisms from the AUTH line, upper-cased. */
  readonly auth: readonly string[];
};

export type SmtpClient = {
  readonly greeting: () => Promise<SmtpResult<SmtpReply>>;
  readonly ehlo: (clientName: string) => Promise<SmtpResult<SmtpCapabilities>>;
  /** PLAIN when offered, else LOGIN; credentials are base64 on the wire, so TLS is assumed. */
  readonly authenticate: (username: string, password: string) => Promise<SmtpResult<void>>;
  /** MAIL FROM, one RCPT TO per recipient, DATA, the dot-stuffed message, QUIT is the caller's. */
  readonly send: (envelope: SmtpEnvelope) => Promise<SmtpResult<SmtpReply>>;
  readonly quit: () => Promise<SmtpResult<void>>;
};

export type SmtpEnvelope = {
  readonly from: string;
  readonly to: readonly string[];
  /** The RFC 5322 message, CRLF line endings, no trailing terminator. */
  readonly data: Uint8Array;
};

const encoder = new TextEncoder();

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const isSuccess = (code: number) => code >= 200 && code < 300;

const refused = (reply: SmtpReply): SmtpResult<never> => ({
  ok: false,
  reason: { kind: 'reply', code: reply.code, text: reply.lines.join(' ') },
});

/** A bare address may not contain the characters that would end or alter the command. */
const isCommandSafe = (address: string) => /^[^\s<>\r\n]+$/.test(address);

/**
 * RFC 5321 §4.5.2: a line beginning with `.` gets a second `.`; the message ends at `CRLF.CRLF`.
 * Done on bytes so a body is never decoded and re-encoded on the way out.
 */
export const dotStuff = (data: Uint8Array): Uint8Array => {
  const out: number[] = [];
  let atLineStart = true;
  for (const byte of data) {
    if (atLineStart && byte === 0x2e) out.push(0x2e);
    out.push(byte);
    atLineStart = byte === 0x0a;
  }
  // Terminate the last line if the message did not, then the lone dot.
  if (!atLineStart) out.push(0x0d, 0x0a);
  out.push(0x2e, 0x0d, 0x0a);
  return Uint8Array.from(out);
};

export const createSmtpClient = (transport: ByteDuplex): SmtpClient => {
  const reader = createLineReader(transport);
  let inData = false;
  let capabilities: SmtpCapabilities = { keywords: [], auth: [] };

  const command = async (line: string): Promise<SmtpResult<SmtpReply>> => {
    try {
      await transport.write(encoder.encode(`${line}\r\n`));
    } catch (error) {
      return {
        ok: false,
        reason: { kind: 'protocol', detail: `write failed: ${String(error)}` },
      };
    }
    return readReply(reader);
  };

  const expect = async (
    line: string,
    ...codes: readonly number[]
  ): Promise<SmtpResult<SmtpReply>> => {
    const reply = await command(line);
    if (!reply.ok) return reply;
    const accepted =
      codes.length === 0 ? isSuccess(reply.value.code) : codes.includes(reply.value.code);
    return accepted ? reply : refused(reply.value);
  };

  const greeting = async (): Promise<SmtpResult<SmtpReply>> => {
    const reply = await readReply(reader);
    if (!reply.ok) return reply;
    return reply.value.code === 220 ? reply : refused(reply.value);
  };

  const ehlo = async (clientName: string): Promise<SmtpResult<SmtpCapabilities>> => {
    const reply = await expect(`EHLO ${clientName}`, 250);
    if (!reply.ok) return reply;
    // The first line is the server's name; the rest are keywords with optional parameters.
    const keywordLines = reply.value.lines.slice(1).map(line => line.trim().toUpperCase());
    const authLine = keywordLines.find(line => line === 'AUTH' || line.startsWith('AUTH '));
    capabilities = {
      keywords: keywordLines.map(line => line.split(' ')[0] ?? line),
      auth: authLine === undefined ? [] : authLine.split(' ').slice(1),
    };
    return { ok: true, value: capabilities };
  };

  const authenticate = async (username: string, password: string): Promise<SmtpResult<void>> => {
    const mechanisms = capabilities.auth;
    if (mechanisms.includes('PLAIN')) {
      const initial = base64(encoder.encode(`\0${username}\0${password}`));
      const reply = await expect(`AUTH PLAIN ${initial}`, 235);
      return reply.ok ? { ok: true, value: undefined } : reply;
    }
    if (mechanisms.includes('LOGIN')) {
      const challenge = await expect('AUTH LOGIN', 334);
      if (!challenge.ok) return challenge;
      const user = await expect(base64(encoder.encode(username)), 334);
      if (!user.ok) return user;
      const done = await expect(base64(encoder.encode(password)), 235);
      return done.ok ? { ok: true, value: undefined } : done;
    }
    return {
      ok: false,
      reason: {
        kind: 'unsupported',
        detail:
          mechanisms.length === 0
            ? 'Server offers no AUTH (was EHLO sent?)'
            : `Server offers only ${mechanisms.join(', ')}`,
      },
    };
  };

  const send = async (envelope: SmtpEnvelope): Promise<SmtpResult<SmtpReply>> => {
    for (const address of [envelope.from, ...envelope.to]) {
      if (!isCommandSafe(address)) {
        return { ok: false, reason: { kind: 'protocol', detail: `unsafe address: ${address}` } };
      }
    }
    if (envelope.to.length === 0) {
      return { ok: false, reason: { kind: 'protocol', detail: 'no recipients' } };
    }
    // BODY=8BITMIME is offered only when the server announced it; the message builder keeps the
    // body 7-bit anyway, so this is belt and braces rather than a requirement.
    const bodyParam = capabilities.keywords.includes('8BITMIME') ? ' BODY=8BITMIME' : '';
    const mailFrom = await expect(`MAIL FROM:<${envelope.from}>${bodyParam}`, 250);
    if (!mailFrom.ok) return mailFrom;
    for (const recipient of envelope.to) {
      // 252: the server will not VRFY but takes the message anyway (RFC 5321 §3.5.3).
      const rcpt = await expect(`RCPT TO:<${recipient}>`, 250, 251, 252);
      if (!rcpt.ok) return rcpt;
    }
    const data = await expect('DATA', 354);
    if (!data.ok) return data;
    try {
      await transport.write(dotStuff(envelope.data));
    } catch (error) {
      // The server is still inside DATA: anything sent now, QUIT included, is read as body text
      // and never answered. Only dropping the connection ends it.
      inData = true;
      return { ok: false, reason: { kind: 'protocol', detail: `write failed: ${String(error)}` } };
    }
    const accepted = await readReply(reader);
    if (!accepted.ok) return accepted;
    return accepted.value.code === 250 ? accepted : refused(accepted.value);
  };

  const quit = async (): Promise<SmtpResult<void>> => {
    if (inData) {
      return {
        ok: false,
        reason: { kind: 'protocol', detail: 'connection abandoned inside DATA' },
      };
    }
    const reply = await expect('QUIT', 221);
    return reply.ok ? { ok: true, value: undefined } : reply;
  };

  return { greeting, ehlo, authenticate, send, quit };
};
