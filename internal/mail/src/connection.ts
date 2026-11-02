import type { ImapClient, ImapFailure, ImapResult, ImapSelected } from '@yozz.app/imap';
import type { SmtpFailure } from '@yozz.app/smtp';

/**
 * The IMAP session mail work runs on. Each client has one implementation: the web app's live
 * connection over the relay, the CLI's own connection.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type MailConnectionFailure =
  | { readonly kind: 'relay'; readonly detail: string }
  /** Something threw outside the protocol layers. */
  | { readonly kind: 'error'; readonly detail: string }
  | { readonly kind: 'tls'; readonly detail: string }
  | { readonly kind: 'imap'; readonly reason: ImapFailure }
  | { readonly kind: 'smtp'; readonly reason: SmtpFailure }
  | { readonly kind: 'auth'; readonly text: string }
  /** Work waited out its limit with nothing crossing the connection. */
  | { readonly kind: 'stalled' };

export type MailClient = ImapClient & {
  /**
   * SELECT only if `name` is not already the selected mailbox. Sync calls `client.select` directly
   * because it wants fresh UIDVALIDITY/UIDNEXT; body fetches and flag writes use this.
   */
  readonly ensureSelected: (name: string) => Promise<ImapResult<ImapSelected>>;
};

export type MailTask<T> = {
  readonly run: (client: MailClient) => Promise<Result<T, MailConnectionFailure>>;
  /** User-initiated work (open a body, a flag write, a sync) runs before prefetch. */
  readonly priority: 'user' | 'background';
  /** A `write` changes the mailbox (a move, a flag, an APPEND); a reload must not drop it unasked. */
  readonly effect: 'read' | 'write';
  /** Whether the task may be re-run on a fresh connection after a transport failure. APPEND must not. */
  readonly retry: boolean;
};

/**
 * How long an APPEND may go with nothing crossing the connection. A server can go quiet for minutes
 * once a large message is written (seen on Forward Email at 33 MiB), and a dead server still fails a
 * small APPEND in about a minute.
 */
export const appendQuietLimitMs = (bytes: number): number => 60_000 + (bytes / 2 ** 20) * 15_000;

/** Runs a task on one account's session. */
export type RunTask = <T>(task: MailTask<T>) => Promise<Result<T, MailConnectionFailure>>;
