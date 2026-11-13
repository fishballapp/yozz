import { cn } from 'cn';
import type { ReactNode } from 'react';
import { proseClass } from '../ui/PageSection';
import { Wordmark } from '../ui/Wordmark';
import { getApiBaseUrl, isApiConfigured } from './api-base-url';

/** A section of an auth screen: sentence case at reading size, so it outranks the field labels under it. */
export const authHeadingClass = 'text-[15px] leading-snug font-medium text-paper';

/** A paragraph on an auth screen. */
export const authProseClass = cn(proseClass, 'text-paper-dim');

/** A screen's main action: on a phone it spans the column at thumb height. */
export const authActionClass = 'max-sm:h-11 max-sm:w-full';

/** The bare frame the vault screens share; owns the "backend not configured" refusal. */
export const AuthColumn = ({
  title,
  description,
  progress,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  /** Where this screen sits in setting up an account, above the title. */
  progress?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  const isConfigured = isApiConfigured();

  return (
    <div className="flex min-h-dvh flex-col bg-ink px-5 py-8 sm:px-8">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <Wordmark className="h-5 w-auto text-paper" />
        {progress !== undefined && <div className="mt-10">{progress}</div>}
        <h1
          className={cn(
            'text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper',
            progress === undefined ? 'mt-10' : 'mt-4',
          )}
        >
          {title}
        </h1>
        {description !== undefined && <p className={cn('mt-2', authProseClass)}>{description}</p>}

        {isConfigured ? (
          <>
            <div className="mt-8">{children}</div>
            {footer !== undefined && (
              <div className="mt-8 border-t border-rule-soft pt-6">{footer}</div>
            )}
          </>
        ) : (
          <div className="mt-8 border-y border-rule bg-ink-raised px-4 py-3.5">
            <p className="label-rule">No backend configured</p>
            <p className={cn('mt-2', authProseClass)}>
              Logging in needs the YOZZ API worker, and no address for it was supplied at build
              time. Set <span className="font-mono text-2xs text-paper">VITE_API_URL</span> before
              starting the app. Nothing on this screen will work until then.
            </p>
            <p className="mt-3 font-mono text-2xs text-paper-faint">Would call {getApiBaseUrl()}</p>
          </div>
        )}
      </div>
    </div>
  );
};
