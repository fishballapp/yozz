import { Dialog } from '@base-ui/react/dialog';
import { Popover } from '@base-ui/react/popover';
import { ArrowLeftIcon, EyeIcon } from '@phosphor-icons/react';
import { Button } from '../ui/Button';
import { MarkdownView } from './MarkdownView';

const MARKDOWN_MARKS = [
  { mark: '**bold**', result: 'bold' },
  { mark: '- item', result: 'a bulleted list' },
  { mark: '> quote', result: 'an indented quote' },
  { mark: '[text](url)', result: 'a link' },
] as const;

/** The four marks mail keeps, beside the message they were typed into. */
const MarkdownCheatSheet = () => (
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

/**
 * The message as it will be read, opened over the draft and closed back to it. Most mail is plain
 * text, which the write surface already shows as it is sent, so this is a look and not a mode.
 */
export const DraftPreview = ({ body }: { body: string }) => (
  <Dialog.Root>
    <Dialog.Trigger
      render={
        <Button variant="ghost" size="sm" className="h-11 lg:h-7">
          <EyeIcon size={13} />
          Preview
        </Button>
      }
    />
    <Dialog.Portal>
      <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto sm:p-6 lg:p-10">
        <Dialog.Popup className="flex min-h-dvh w-full flex-col bg-ink-raised outline-none transition-[opacity,translate] duration-150 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0 sm:h-[min(46rem,calc(100dvh-3rem))] sm:min-h-0 sm:max-w-3xl sm:border sm:border-rule">
          <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule-soft pr-1 pl-4">
            <Dialog.Title className="label-rule mr-auto truncate text-paper-dim">
              Preview
            </Dialog.Title>
            <MarkdownCheatSheet />
            {/* Named, not an ✕: this plate covers the composer, whose ✕ closes the draft. */}
            <Dialog.Close
              render={
                <Button variant="ghost" size="sm" className="h-11 lg:h-7">
                  <ArrowLeftIcon size={13} />
                  Back to draft
                </Button>
              }
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {body.trim() === '' ? (
              <p className="text-base text-paper-faint">Nothing to preview yet.</p>
            ) : (
              <MarkdownView source={body} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Viewport>
    </Dialog.Portal>
  </Dialog.Root>
);
