/**
 * A failure as one line, for a harness that has to report one.
 *
 * Both halves of the M8 gate report the same two kinds of failure — a
 * `TlsFailure` the client returned, and something that threw — so both live
 * here, and `page.ts` imports them into the browser. Nothing in this file is
 * Node.
 *
 * The BoGo shim keeps its OWN copy of the `TlsFailure` wording on purpose:
 * BoringSSL's `ErrorMap` matches it as a SUBSTRING, so its field order is a
 * contract, and this one's is just prose.
 */
import type { TlsFailure } from '../src/alert.ts';

export const describeFailure = (failure: TlsFailure): string => {
  switch (failure.kind) {
    case 'alert-sent':
      return `we sent ${failure.alert.description}`;
    case 'alert-received':
      return `server sent ${failure.alert.description}`;
    case 'alert-received-unknown':
      return `server sent unknown alert ${failure.code}`;
    case 'truncated':
      return 'connection truncated';
    case 'certificate':
      return `certificate ${failure.reason.code} (${failure.alert.description}, chain=${failure.chain})`;
  }
};

/**
 * A thrown value as one line.
 *
 * `error.message` alone is not enough, and the negative control is what showed
 * it: a TCP timeout reaches Node as an `Error` with an EMPTY message and the
 * only useful word — `ETIMEDOUT` — hiding in `code`. Reporting the message
 * printed a blank line, which is a diagnostic that says a host failed and
 * refuses to say how.
 */
export const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  const code = 'code' in error ? error.code : undefined;
  return code === undefined ? error.name : String(code);
};
