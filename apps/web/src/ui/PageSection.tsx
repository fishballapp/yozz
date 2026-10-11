import type { ReactNode } from 'react';

/**
 * A labelled block of a settings pane, under the pane's own `h2`. What went wrong in a section is
 * said inside it, under its content, where the person who just acted is still looking.
 */
export const PageSection = ({
  id,
  label,
  note,
  action,
  error,
  children,
}: {
  /** The heading's id, for a control the heading labels (`aria-labelledby`). */
  id?: string;
  label: string;
  note?: ReactNode;
  /** A control that belongs to the whole section, such as Edit, set on the heading rule's right end. */
  action?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) => (
  <section className="mb-10">
    <div className="flex items-center justify-between gap-4 border-b border-rule pb-2">
      <h3 id={id} className="label-rule">
        {label}
      </h3>
      {/* Centred on the label and flush with the rule's end; its own padding stays a hit area. */}
      {action !== undefined && <div className="-my-1.5 -mr-2.5">{action}</div>}
    </div>
    {note !== undefined && (
      <p className="mt-3 max-w-xl text-base leading-relaxed text-paper-dim">{note}</p>
    )}
    <div className="mt-3">{children}</div>
    {error !== undefined && error !== null && (
      <p role="alert" className="mt-3 max-w-xl text-base text-danger">
        {error}
      </p>
    )}
  </section>
);

/** A `label · value` line inside a `<dl>`: chrome type left, the machine value right. */
export const Definition = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex items-baseline gap-4 border-b border-rule-soft py-2.5">
    <dt className="label-rule w-24 shrink-0">{term}</dt>
    <dd className="min-w-0 flex-1 truncate font-mono text-2xs text-paper">{children}</dd>
  </div>
);
