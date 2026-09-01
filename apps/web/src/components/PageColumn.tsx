import type { ReactNode } from 'react';

/** The reading column Settings and Add an address share; the shell around it is `AppShell`'s. */
export const PageColumn = ({
  title,
  description,
  nav,
  children,
}: {
  title: string;
  description?: string;
  nav?: ReactNode;
  children: ReactNode;
}) => (
  <main className="min-w-0 flex-1 overflow-y-auto bg-ink-sunken">
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8">
      <h1 className="text-[19px] leading-tight font-medium tracking-[-0.015em] text-paper">
        {title}
      </h1>
      {description !== undefined && (
        <p className="mt-2 max-w-xl text-base leading-relaxed text-paper-dim">{description}</p>
      )}
      {nav}
      <div className={nav === undefined ? 'mt-8' : 'mt-6'}>{children}</div>
    </div>
  </main>
);

/** A labelled block inside a `PageColumn`. */
export const PageSection = ({
  label,
  note,
  action,
  children,
}: {
  label: string;
  note?: ReactNode;
  /** A control that belongs to the whole section, set on the heading rule's right end. */
  action?: ReactNode;
  children: ReactNode;
}) => (
  <section className="mb-10">
    <div className="flex items-end justify-between gap-4 border-b border-rule pb-2">
      <h2 className="label-rule">{label}</h2>
      {action}
    </div>
    {note !== undefined && (
      <p className="mt-3 max-w-xl text-base leading-relaxed text-paper-dim">{note}</p>
    )}
    <div className="mt-3">{children}</div>
  </section>
);

/** A `label · value` line inside a `<dl>`: chrome type left, the machine value right. */
export const Definition = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex items-baseline gap-4 border-b border-rule-soft py-2.5">
    <dt className="label-rule w-24 shrink-0">{term}</dt>
    <dd className="min-w-0 flex-1 truncate font-mono text-2xs text-paper">{children}</dd>
  </div>
);
