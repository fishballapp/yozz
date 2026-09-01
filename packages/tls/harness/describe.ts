/**
 * One-line failure descriptions shared by the Node and browser drivers; nothing here is Node.
 * The BoGo shim keeps its own `TlsFailure` wording because `ErrorMap` matches it as a substring.
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

/** A TCP timeout reaches Node as an `Error` with an empty message and `ETIMEDOUT` in `code`. */
export const errorText = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  if (error.message !== '') return error.message;
  const code = 'code' in error ? error.code : undefined;
  return code === undefined ? error.name : String(code);
};
