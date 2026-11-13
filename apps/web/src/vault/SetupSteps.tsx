import { CheckIcon } from '@phosphor-icons/react';
import { cn } from 'cn';
import { Fragment } from 'react';

/**
 * The three things a new account does, in order, from the first screen to the first address. One
 * word each, so the line stays on one line on a phone. Step 2 is "Login", not "Passkey": a browser
 * that cannot unlock with a passkey sets a password there.
 */
const SETUP_STEPS = ['Email', 'Login', 'Address'] as const;

export type SetupStep = 1 | 2 | 3;

const stateOf = (step: number, current: SetupStep) => {
  if (step < current) return 'done';
  if (step === current) return 'current';
  return 'pending';
};

/** One mono line across welcome, enrol and the first address: a finished step ticked, the current one lit. */
export const SetupSteps = ({ current }: { current: SetupStep }) => (
  <ol
    aria-label="Setting up YOZZ"
    className="flex items-center gap-x-2 font-mono text-2xs whitespace-nowrap text-paper-faint"
  >
    {SETUP_STEPS.map((label, index) => {
      const step = index + 1;
      const state = stateOf(step, current);
      const isDone = state === 'done';
      const isCurrent = state === 'current';
      return (
        <Fragment key={label}>
          {index > 0 && (
            <li aria-hidden className="text-paper-faint">
              ·
            </li>
          )}
          <li
            aria-current={isCurrent ? 'step' : undefined}
            data-state={state}
            className={cn(
              'flex items-center gap-1.5',
              isDone && 'text-paper-dim',
              isCurrent && 'font-medium text-paper',
            )}
          >
            {isDone ? (
              <CheckIcon
                size={10}
                weight="bold"
                className="text-signal"
                aria-label="Done:"
                role="img"
              />
            ) : (
              <span>{step}</span>
            )}
            {label}
          </li>
        </Fragment>
      );
    })}
  </ol>
);
