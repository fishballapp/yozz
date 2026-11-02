import {
  createLineReader,
  readReply,
  type SmtpFailure,
  type SmtpReply,
  type SmtpResult,
} from './reply.ts';
import type { ByteDuplex } from './transport.ts';

export type SmtpCapabilities = {
  /** EHLO keywords, upper-cased, e.g. `SIZE`, `8BITMIME`, `SMTPUTF8`, `PIPELINING`. */
  readonly keywords: readonly string[];
  /** SASL mechanisms from the AUTH line, upper-cased. */
  readonly auth: readonly string[];
  /** RFC 1870's `SIZE <n>`: the largest message the server takes, or null for none declared (`SIZE`, `SIZE 0`, no `SIZE`). */
  readonly maxMessageBytes: number | null;
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

const isCommandSafe = (address: string) => /^[^\s<>\r\n]+$/.test(address);

/** RFC 1870 §4: `SIZE` alone, or with 0, declares no fixed limit. */
const maxMessageBytesOf = (keywordLines: readonly string[]): number | null => {
  const line = keywordLines.find(candidate => candidate.startsWith('SIZE '));
  const limit = Number(line?.slice('SIZE '.length));
  return Number.isSafeInteger(limit) && limit > 0 ? limit : null;
};

/** `.` CR LF, the end of the message after `dotStuff`'s final CRLF. */
const DATA_TERMINATOR_BYTES = 3;

/** Why the answer to the end of DATA, if any, says nothing about the message. */
const unconfirmedDetail = (reason: SmtpFailure): string => {
  if (reason.kind === 'closed') return 'the connection closed before the server answered';
  if (reason.kind === 'reply') return `neither yes nor no: ${reason.code} ${reason.text}`;
  // `send` refuses on size before writing, so this never ends in an abandoned DATA; the union still has it.
  if (reason.kind === 'too-large') return `over the ${reason.limitBytes} bytes the server takes`;
  return reason.detail;
};

/** RFC 5321 §4.5.3.2's five minutes, the longest it gives any reply but the one below. */
const REPLY_TIMEOUT_MS = 5 * 60 * 1000;
/** §4.5.3.2.6: the wait after the terminator is the long one, as the server may be delivering. */
export const DATA_END_TIMEOUT_MS = 10 * 60 * 1000;

const DOT = 0x2e;
const CR = 0x0d;
const LF = 0x0a;

/**
 * RFC 5321 §4.5.2: a line beginning with `.` gets a second `.`; the message ends at `CRLF.CRLF`.
 * Sized first and written once, since a message is tens of megabytes.
 */
export const dotStuff = (data: Uint8Array): Uint8Array => {
  let stuffedDots = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === DOT && (i === 0 || data[i - 1] === LF)) stuffedDots += 1;
  }
  const endsLine = data.length === 0 || data[data.length - 1] === LF;
  const out = new Uint8Array(
    data.length + stuffedDots + (endsLine ? 0 : 2) + DATA_TERMINATOR_BYTES,
  );
  let at = 0;
  for (let i = 0; i < data.length; i += 1) {
    const byte = data[i] ?? 0;
    if (byte === DOT && (i === 0 || data[i - 1] === LF)) {
      out[at] = DOT;
      at += 1;
    }
    out[at] = byte;
    at += 1;
  }
  if (!endsLine) {
    out[at] = CR;
    out[at + 1] = LF;
    at += 2;
  }
  out.set([DOT, CR, LF], at);
  return out;
};

export const createSmtpClient = (transport: ByteDuplex): SmtpClient => {
  const reader = createLineReader(transport);
  /**
   * DATA ended in a state nobody knows, or a reply never came: the server may still be reading the
   * message, or answer late, so anything written now, QUIT included, could be read as body text or
   * paired with the wrong reply. Nothing more is written.
   */
  let isAbandoned = false;
  let capabilities: SmtpCapabilities = { keywords: [], auth: [], maxMessageBytes: null };

  /** A silent server fails after `ms`. The read left behind ends when the caller closes the transport. */
  const readReplyWithin = async (ms: number): Promise<SmtpResult<SmtpReply>> => {
    const expired = Promise.withResolvers<SmtpResult<SmtpReply>>();
    const timer = setTimeout(() => {
      isAbandoned = true;
      expired.resolve({
        ok: false,
        reason: { kind: 'protocol', detail: `no reply in ${ms / 60_000} minutes` },
      });
    }, ms);
    try {
      return await Promise.race([readReply(reader), expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  };

  const command = async (line: string): Promise<SmtpResult<SmtpReply>> => {
    if (isAbandoned) {
      return {
        ok: false,
        reason: { kind: 'protocol', detail: 'connection abandoned' },
      };
    }
    try {
      await transport.write(encoder.encode(`${line}\r\n`));
    } catch (error) {
      return {
        ok: false,
        reason: { kind: 'protocol', detail: `write failed: ${String(error)}` },
      };
    }
    return readReplyWithin(REPLY_TIMEOUT_MS);
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
    const reply = await readReplyWithin(REPLY_TIMEOUT_MS);
    if (!reply.ok) return reply;
    return reply.value.code === 220 ? reply : refused(reply.value);
  };

  const ehlo = async (clientName: string): Promise<SmtpResult<SmtpCapabilities>> => {
    const reply = await expect(`EHLO ${clientName}`, 250);
    if (!reply.ok) return reply;
    // RFC 5321 §4.1.1.1: the first line is the server's name, not a keyword.
    const keywordLines = reply.value.lines.slice(1).map(line => line.trim().toUpperCase());
    const authLine = keywordLines.find(line => line === 'AUTH' || line.startsWith('AUTH '));
    capabilities = {
      keywords: keywordLines.map(line => line.split(' ')[0] ?? line),
      auth: authLine === undefined ? [] : authLine.split(' ').slice(1),
      maxMessageBytes: maxMessageBytesOf(keywordLines),
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

  /** What `send` answers once the end of the message was written and no usable answer came back. */
  const abandon = (reason: SmtpFailure): SmtpResult<never> => {
    isAbandoned = true;
    return { ok: false, reason: { kind: 'unconfirmed', detail: unconfirmedDetail(reason) } };
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
    const { maxMessageBytes } = capabilities;
    // Before anything is written: a message the server would refuse at the end of DATA is not uploaded.
    if (maxMessageBytes !== null && envelope.data.length > maxMessageBytes) {
      return { ok: false, reason: { kind: 'too-large', limitBytes: maxMessageBytes } };
    }
    const params = [
      ...(capabilities.keywords.includes('SIZE') ? [`SIZE=${envelope.data.length}`] : []),
      ...(capabilities.keywords.includes('8BITMIME') ? ['BODY=8BITMIME'] : []),
    ];
    const mailFrom = await expect(
      `MAIL FROM:<${envelope.from}>${params.map(param => ` ${param}`).join('')}`,
      250,
    );
    if (!mailFrom.ok) return mailFrom;
    for (const recipient of envelope.to) {
      // 252: the server cannot verify the address but accepts the message (RFC 5321 §3.5.3).
      const rcpt = await expect(`RCPT TO:<${recipient}>`, 250, 251, 252);
      if (!rcpt.ok) return rcpt;
    }
    const data = await expect('DATA', 354);
    if (!data.ok) return data;
    // The terminator is written on its own, and only once the message has gone: a message the server
    // never saw end is one it discards (RFC 5321 §4.1.1.4), so only a failure from here on can have
    // delivered anything.
    const stuffed = dotStuff(envelope.data);
    const terminatorAt = stuffed.length - DATA_TERMINATOR_BYTES;
    try {
      await transport.write(stuffed.subarray(0, terminatorAt));
      await transport.flush?.();
    } catch (error) {
      // The server is still inside DATA, waiting for an end it never saw: nothing went out.
      isAbandoned = true;
      return { ok: false, reason: { kind: 'protocol', detail: `write failed: ${String(error)}` } };
    }
    // From here the server may hold the message, and the connection's state is unknown: nothing
    // more is written on it, and a failure is `unconfirmed`, never a refusal.
    const accepted = await (async (): Promise<SmtpResult<SmtpReply>> => {
      try {
        await transport.write(stuffed.subarray(terminatorAt));
      } catch (error) {
        return {
          ok: false,
          reason: { kind: 'protocol', detail: `write failed: ${String(error)}` },
        };
      }
      try {
        return await readReplyWithin(DATA_END_TIMEOUT_MS);
      } catch (error) {
        return { ok: false, reason: { kind: 'protocol', detail: `read failed: ${String(error)}` } };
      }
    })();
    if (!accepted.ok) return abandon(accepted.reason);
    const { code } = accepted.value;
    if (code >= 200 && code < 300) return accepted;
    // The server answered, and the answer was no: nothing went out.
    if (code >= 400 && code < 600) return refused(accepted.value);
    // Not an answer RFC 5321 allows here, so whether the server took the message is unknown.
    return abandon({ kind: 'reply', code, text: accepted.value.lines.join(' ') });
  };

  const quit = async (): Promise<SmtpResult<void>> => {
    const reply = await expect('QUIT', 221);
    return reply.ok ? { ok: true, value: undefined } : reply;
  };

  return { greeting, ehlo, authenticate, send, quit };
};
