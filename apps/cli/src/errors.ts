import { CliLoginError } from '@fishballapps/cli-login';
import * as Config from 'effect/Config';
import type * as CliError from 'effect/cli/CliError';
import * as Effect from 'effect/Effect';
import * as PlatformError from 'effect/PlatformError';
import * as Schema from 'effect/Schema';
import { type Failure, fail } from './output.ts';

// Every expected failure is one of these, and its tag is its `code` on the error line
// (docs/cli-design.md, Output). A command's own errors live beside it and are added here.

export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
}) {}

export class NotLoggedIn extends Schema.TaggedError<NotLoggedIn>()('NotLoggedIn', {
  message: Schema.String,
}) {}

/** The Worker no longer knows the key (revoked, or deleted with a reset), or its wrap no longer opens the vault. */
export class KeyRevoked extends Schema.TaggedError<KeyRevoked>()('KeyRevoked', {
  message: Schema.String,
}) {}

export class NetworkError extends Schema.TaggedError<NetworkError>()('NetworkError', {
  message: Schema.String,
}) {}

/** The YOZZ API refused a request for a reason other than the key (a conflict, a limit, its own fault). */
export class ApiError extends Schema.TaggedError<ApiError>()('ApiError', {
  message: Schema.String,
  status: Schema.Int,
}) {}

/** A record that did not open, or one older than this machine has already seen (a replay). */
export class VaultUnreadable extends Schema.TaggedError<VaultUnreadable>()('VaultUnreadable', {
  message: Schema.String,
}) {}

/** The approval came back, but did not open with this login's key. */
export class LoginFailed extends Schema.TaggedError<LoginFailed>()('LoginFailed', {
  message: Schema.String,
}) {}

/** An id that names nothing this machine's cache or the vault holds. */
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
  message: Schema.String,
}) {}

/** An IMAP, SMTP, TLS or sign-in failure, naming the address and saying what went wrong. */
export class MailServerError extends Schema.TaggedError<MailServerError>()('MailServerError', {
  message: Schema.String,
  address: Schema.String,
}) {}

/** `list --wait` elapsed with no new mail. */
export class WaitTimedOut extends Schema.TaggedError<WaitTimedOut>()('WaitTimedOut', {
  message: Schema.String,
}) {}

/** Some of a batch failed: `output` still prints on stdout, each failed row carrying its error. */
export class PartialFailure extends Schema.TaggedError<PartialFailure>()('PartialFailure', {
  message: Schema.String,
  output: Schema.Unknown,
}) {}

export type CliFailure =
  | UsageError
  | NotLoggedIn
  | KeyRevoked
  | NetworkError
  | ApiError
  | VaultUnreadable
  | LoginFailed
  | NotFound
  | MailServerError
  | WaitTimedOut
  | PartialFailure;

const LOGIN_FAILURE_CODES = {
  Denied: 'LoginDenied',
  TimedOut: 'LoginTimedOut',
  Unavailable: 'LoginFailed',
} as const;

type ReportedError = CliFailure | CliLoginError | PlatformError.PlatformError | Config.ConfigError;

const toFailure = (error: ReportedError): Failure => {
  if (error instanceof CliLoginError) {
    return { code: LOGIN_FAILURE_CODES[error.reason], message: error.message };
  }
  // A file the CLI could not read or write: the person's to fix.
  if (PlatformError.isPlatformError(error)) return { code: 'UsageError', message: error.message };
  if (error instanceof Config.ConfigError) return { code: 'UsageError', message: error.message };
  if (error instanceof PartialFailure) return { code: error._tag, message: error.message };
  const { _tag, ...fields } = error;
  return { ...fields, code: _tag, message: error.message };
};

/** Turns a command's failure into its one error line, after a partial failure's output. */
export const reportFailure = <A, R>(
  effect: Effect.Effect<A, ReportedError, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  Effect.catch(effect, error =>
    fail(toFailure(error), error instanceof PartialFailure ? { output: error.output } : {}),
  );
