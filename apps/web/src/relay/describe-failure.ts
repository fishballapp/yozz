import type { MailConnectionFailure } from './connection';

/** One sentence for a failed connection, the same on Connect and on a sync. */
export const describeMailFailure = (failure: MailConnectionFailure, host: string): string => {
  switch (failure.kind) {
    case 'relay':
      return `Could not reach the relay: ${failure.detail}`;
    case 'error':
      return failure.detail;
    case 'tls':
      return `Secure connection to ${host} failed: ${failure.detail}`;
    case 'pin-mismatch':
      return `${failure.peer} presented a key YOZZ has not seen from it before. If you expect the server to have been re-keyed, forget its pinned key under Settings → Server keys and retry.`;
    case 'auth':
      return `${host} rejected the username or password`;
    case 'smtp': {
      const { reason } = failure;
      const text =
        reason.kind === 'reply'
          ? `${reason.code} ${reason.text}`
          : reason.kind === 'protocol' || reason.kind === 'unsupported'
            ? reason.detail
            : reason.kind;
      return `${host}: ${text}`;
    }
    case 'imap':
      return `${host}: ${
        failure.reason.kind === 'no' ||
        failure.reason.kind === 'bad' ||
        failure.reason.kind === 'bye'
          ? failure.reason.text
          : failure.reason.kind
      }`;
  }
};
