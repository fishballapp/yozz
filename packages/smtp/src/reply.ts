import type { ByteDuplex } from './transport.ts';

export type SmtpReply = {
  readonly code: number;
  /** One entry per line, the `NNN-` / `NNN ` prefix removed. */
  readonly lines: readonly string[];
};

export type SmtpFailure =
  /** The server answered, and the answer was no: 4xx (try later) or 5xx (do not). */
  | { readonly kind: 'reply'; readonly code: number; readonly text: string }
  | { readonly kind: 'closed' }
  | { readonly kind: 'protocol'; readonly detail: string }
  | { readonly kind: 'unsupported'; readonly detail: string };

export type SmtpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: SmtpFailure };

/** RFC 5321 §4.5.3.1.5 says 512 octets; real servers write longer EHLO lines. */
const MAX_LINE_BYTES = 4096;
const MAX_REPLY_LINES = 64;

const asciiDecoder = new TextDecoder('ascii');

export const createLineReader = (transport: ByteDuplex) => {
  let buffer = new Uint8Array(0);
  let isClosed = false;

  const readLine = async (): Promise<SmtpResult<string>> => {
    for (;;) {
      const lf = buffer.indexOf(0x0a);
      if (lf > MAX_LINE_BYTES || (lf === -1 && buffer.length > MAX_LINE_BYTES)) {
        return { ok: false, reason: { kind: 'protocol', detail: 'reply line too long' } };
      }
      if (lf !== -1) {
        if (lf === 0 || buffer[lf - 1] !== 0x0d) {
          return { ok: false, reason: { kind: 'protocol', detail: 'bare LF in reply' } };
        }
        const line = asciiDecoder.decode(buffer.subarray(0, lf - 1));
        buffer = buffer.slice(lf + 1);
        return { ok: true, value: line };
      }
      if (isClosed) return { ok: false, reason: { kind: 'closed' } };
      const chunk = await transport.read();
      if (chunk === null) {
        isClosed = true;
        continue;
      }
      const merged = new Uint8Array(buffer.length + chunk.length);
      merged.set(buffer, 0);
      merged.set(chunk, buffer.length);
      buffer = merged;
    }
  };

  return { readLine };
};

const REPLY_LINE = /^(\d{3})([ -])(.*)$/;

export const readReply = async (
  reader: ReturnType<typeof createLineReader>,
): Promise<SmtpResult<SmtpReply>> => {
  const lines: string[] = [];
  let code: number | null = null;
  for (;;) {
    const line = await reader.readLine();
    if (!line.ok) return line;
    const match = REPLY_LINE.exec(line.value);
    if (match === null) {
      return { ok: false, reason: { kind: 'protocol', detail: `not a reply line: ${line.value}` } };
    }
    const [, codeText = '', separator, text = ''] = match;
    const lineCode = Number(codeText);
    if (code !== null && lineCode !== code) {
      return {
        ok: false,
        reason: { kind: 'protocol', detail: `reply code changed from ${code} to ${lineCode}` },
      };
    }
    code = lineCode;
    lines.push(text);
    if (separator === ' ') return { ok: true, value: { code, lines } };
    if (lines.length >= MAX_REPLY_LINES) {
      return { ok: false, reason: { kind: 'protocol', detail: 'reply has too many lines' } };
    }
  }
};
