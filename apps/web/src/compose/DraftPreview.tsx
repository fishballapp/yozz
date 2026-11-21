import { Popover } from '@base-ui/react/popover';
import { type AddressRecord, isInbound } from '@yozz.app/mail/addresses/record';
import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { ReactNode, Ref } from 'react';
import { SendOnlyTag } from '../ui/SendOnlyTag';
import { MarkdownView } from './MarkdownView';

const MARKDOWN_MARKS = [
  { mark: '**bold**', result: 'bold' },
  { mark: '- item', result: 'a bulleted list' },
  { mark: '> quote', result: 'an indented quote' },
  { mark: '[text](url)', result: 'a link' },
] as const;

/** The four marks mail keeps, beside the message they are typed into. */
export const MarkdownCheatSheet = () => (
  <Popover.Root>
    <Popover.Trigger className="self-stretch px-2 text-2xs text-paper-faint underline underline-offset-4 outline-none transition-colors hover:text-paper focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal data-[popup-open]:text-paper">
      Markdown supported
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={12}
        className="z-[60]"
      >
        <Popover.Popup
          aria-label="Markdown cheat sheet"
          className="border border-rule bg-ink-raised px-4 py-3 outline-none"
        >
          <dl className="grid grid-cols-[auto_auto] items-baseline gap-x-6 gap-y-1.5 text-base">
            {MARKDOWN_MARKS.map(({ mark, result }) => (
              <div key={mark} className="contents">
                <dt className="font-mono text-paper">{mark}</dt>
                <dd className="text-paper-dim">{result}</dd>
              </div>
            ))}
          </dl>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
);

/** One envelope line, its term in the write step's label column so the two steps align. */
const EnvelopeRow = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="flex items-baseline">
    <dt className="label-rule w-20 shrink-0 pl-4">{term}</dt>
    <dd className="relative min-w-0 flex-1 py-1 pr-4 pl-3">{children}</dd>
  </div>
);

const Addresses = ({ list }: { list: string }) => (
  <span className="font-mono text-2xs text-paper-dim [overflow-wrap:anywhere]">{list}</span>
);

/**
 * The message as it will be read: who it goes from and to, its subject, and the body rendered as
 * the HTML part renders it. The step before Send, so a missing From or recipient shows here.
 */
export const DraftPreview = ({
  draft,
  from,
  ref,
}: {
  draft: ComposeDraft;
  /** The address the draft names, `undefined` when it names none this vault holds. */
  from: AddressRecord | undefined;
  ref?: Ref<HTMLDivElement>;
}) => {
  const hasCopies = draft.cc.trim() !== '' || draft.bcc.trim() !== '';
  return (
    // Focused on arrival, so the keyboard scrolls a long message.
    <div ref={ref} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
      <dl className="border-b border-rule-soft py-2">
        <EnvelopeRow term="From">
          {from === undefined ? (
            <span className="text-base text-paper-faint">(no address selected)</span>
          ) : (
            <>
              {/* The identity channel, as the From switch marks it. */}
              <span className="absolute inset-y-0 left-0 w-0.5 bg-signal" />
              <span className="flex items-center gap-2">
                <span className="truncate text-base text-paper">{from.address}</span>
                {!isInbound(from) && <SendOnlyTag />}
              </span>
              <span className="mt-0.5 block truncate font-mono text-2xs text-paper-faint">
                {from.senderName !== undefined && `${from.senderName} · `}via {from.smtp.host}
              </span>
            </>
          )}
        </EnvelopeRow>
        {draft.to.trim() !== '' && (
          <EnvelopeRow term="To">
            <Addresses list={draft.to} />
          </EnvelopeRow>
        )}
        {draft.to.trim() === '' && !hasCopies && (
          <EnvelopeRow term="To">
            <span className="text-base text-paper-faint">(no recipient)</span>
          </EnvelopeRow>
        )}
        {draft.cc.trim() !== '' && (
          <EnvelopeRow term="Cc">
            <Addresses list={draft.cc} />
          </EnvelopeRow>
        )}
        {draft.bcc.trim() !== '' && (
          <EnvelopeRow term="Bcc">
            <Addresses list={draft.bcc} />
          </EnvelopeRow>
        )}
        <EnvelopeRow term="Subject">
          {draft.subject.trim() === '' ? (
            <span className="text-base text-paper-faint">(no subject)</span>
          ) : (
            <span dir="auto" className="text-base font-medium text-paper">
              {draft.subject}
            </span>
          )}
        </EnvelopeRow>
      </dl>
      <div className="px-4 py-4">
        {draft.body.trim() === '' ? (
          <p className="text-base text-paper-faint">(no message)</p>
        ) : (
          <MarkdownView source={draft.body} />
        )}
      </div>
    </div>
  );
};
