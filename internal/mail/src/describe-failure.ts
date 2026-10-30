import type { MailConnectionFailure } from './connection.ts';

/** One sentence for a failed connection, the same on Connect and on a sync. */
export const describeMailFailure = (failure: MailConnectionFailure, host: string): string => {
  switch (failure.kind) {
    case 'relay':
      return `Could not reach the relay: ${failure.detail}`;
    case 'error':
      return failure.detail;
    case 'tls':
      return `Secure connection to ${host} failed: ${failure.detail === '' ? 'the connection dropped' : failure.detail}`;
    case 'auth':
      return `${host} rejected the username or password`;
    case 'stalled':
      return `${host} has not answered for a minute`;
    case 'smtp': {
      const { reason } = failure;
      const text = (() => {
        if (reason.kind === 'reply') return `${reason.code} ${reason.text}`;
        if (reason.kind === 'unconfirmed') return `no answer to the message · ${reason.detail}`;
        if (reason.kind === 'protocol' || reason.kind === 'unsupported') return reason.detail;
        return reason.kind;
      })();
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
