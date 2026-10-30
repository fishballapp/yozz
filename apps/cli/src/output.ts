import * as Cause from 'effect/Cause';
import * as Console from 'effect/Console';
import * as CliError from 'effect/cli/CliError';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Runtime from 'effect/Runtime';

// clapio's output contract, so every fishball CLI reads the same to an agent: a success is one JSON
// document on stdout, a failure one line on stderr, `{"error":{"code","message",…}}`, and exit 1.
// Written here rather than imported: clapio is not part of YOZZ's public tree.

/** Why a command failed; an agent matches on `code`. */
export type Failure = {
  readonly code: string;
  readonly message: string;
  readonly [field: string]: unknown;
};

const line = (failure: Failure) => JSON.stringify({ error: failure });

/** What a failed run still prints on stdout: only a partial failure's rows. */
type Output = { readonly output?: unknown };

/** The output a failure carries, read back where the run is reported. */
const outputs = new WeakMap<CliError.UserError, Output>();

/**
 * Fails the command with `failure` as its one JSON line on stderr, and exit 1; `output`, when given,
 * still prints on stdout before it.
 */
export const fail = (failure: Failure, { output }: Output = {}) => {
  const error = new CliError.UserError({ cause: failure, userMessage: line(failure) });
  if (output !== undefined) outputs.set(error, { output });
  return Effect.fail(error);
};

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** A command's result: one pretty-printed JSON document on stdout. Progress goes to stderr. */
export const printJson = (value: unknown) => Console.log(pretty(value));

/** What a run prints: what it held for stdout, its one error line, or nothing (a defect, which the runtime logs on stderr). */
const outputOf = (
  exit: Exit.Exit<unknown, unknown>,
  held: ReadonlyArray<ReadonlyArray<unknown>>,
):
  | { readonly stdout: ReadonlyArray<ReadonlyArray<unknown>> }
  | {
      readonly stdout?: ReadonlyArray<ReadonlyArray<unknown>>;
      readonly stderr: string;
      readonly error: CliError.CliError;
    }
  | null => {
  if (Exit.isSuccess(exit)) return { stdout: held };
  const error = Option.filter(Cause.findErrorOption(exit.cause), CliError.isCliError);
  if (Option.isNone(error)) return null;
  const { value } = error;
  if (value._tag === 'ShowHelp' && value.errors.length === 0) return { stdout: held };
  if (value._tag === 'UserError') {
    const kept = outputs.get(value);
    return {
      ...(kept === undefined ? {} : { stdout: [[pretty(kept.output)]] }),
      stderr: value.message,
      error: value,
    };
  }
  const errors = value._tag === 'ShowHelp' ? value.errors : [value];
  return {
    stderr: line({ code: 'UsageError', message: errors.map(({ message }) => message).join('; ') }),
    error: value,
  };
};

/**
 * Runs `command` on `args` under the contract. effect/cli prints a command's help on stdout before
 * a parse error, and one line per error; so stdout is held until the run ends, and a failed run
 * prints only its one line on stderr. Help asked for (`--help`, or no command) still prints.
 */
export const runCommand =
  <Name extends string, Input, E, R, ContextInput>(
    command: Command.Command<Name, Input, ContextInput, E, R>,
    config: { readonly version: string },
  ) =>
  (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const console = yield* Console.Console;
      const held: unknown[][] = [];
      const exit = yield* Command.runWith(command, { ...config, renderErrors: false })(args).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          log: (...parts: unknown[]) => {
            held.push(parts);
          },
        }),
        Effect.exit,
      );
      const output = outputOf(exit, held);
      for (const parts of output?.stdout ?? []) console.log(...parts);
      if (output !== null && 'stderr' in output) {
        console.error(output.stderr);
        // Reported here, so the runtime doesn't log it again (effect/cli marks it so when it prints).
        Object.assign(output.error, { [Runtime.errorReported]: false });
      }
      return yield* exit;
    });
