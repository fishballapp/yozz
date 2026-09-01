import type { ReactNode } from 'react';
import { getApiBaseUrl, isApiConfigured } from '../vault/api-base-url.ts';
import { Wordmark } from './Wordmark';

/** The bare frame the vault screens share; owns the "backend not configured" refusal. */
export const AuthColumn = ({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) => {
  const isConfigured = isApiConfigured();

  return (
    <div className="flex min-h-dvh flex-col bg-ink px-5 py-8 sm:px-8">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col">
        <Wordmark className="h-5 w-auto text-paper" />
        <h1 className="mt-10 text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-2 text-base leading-relaxed text-paper-dim">{description}</p>
        )}

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
            <p className="mt-2 text-base leading-relaxed text-paper-dim">
              The vault needs the YOZZ API worker, and no address for it was supplied at build time.
              Set <span className="font-mono text-2xs text-paper">VITE_API_URL</span> before
              starting the app. Nothing on this screen will work until then.
            </p>
            <p className="mt-3 font-mono text-2xs text-paper-faint">Would call {getApiBaseUrl()}</p>
          </div>
        )}

        <p className="mt-auto pt-10 font-mono text-2xs tracking-[0.08em] text-paper-faint uppercase">
          Vault only · no mailbox connected
        </p>
      </div>
    </div>
  );
};
