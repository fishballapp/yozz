import { cn } from '@fishballapps/cn';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  BrowserIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  type Icon,
  StarIcon,
  TextAlignLeftIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import { markOf } from '../lib/addresses';
import { useChromePref } from '../lib/chrome';
import { replyAllCc, withCompose } from '../lib/compose';
import { linkify } from '../lib/linkify';
import { ATTACHMENT_LABEL, formatBytes } from '../lib/mail-format';
import { type Attachment, isArchived, type Message, newestInbound } from '../lib/thread';
import { fullTime } from '../lib/time';
import { type ThreadState, useMail } from '../state/mail';
import { HtmlBody } from './HtmlBody';
import { Button, buttonClass } from './ui/Button';
import { IconSwitch } from './ui/IconSwitch';

/**
 * The reader states which of your addresses the mail was delivered to, on its own line under the
 * subject. That is not decoration: it is the fact that decides which identity Reply sends from.
 *
 * The star sits BEFORE the subject, matching its position at the head of a list row, so the same
 * control lives in the same place whether you are scanning or reading.
 *
 * Reply and Forward sit under EVERY message, not once at the foot of the thread. A thread is a
 * sequence of things you can each act on: forwarding the attachment someone sent three messages ago
 * should not mean forwarding the newest message instead, and replying under your own last message
 * is a follow-up that quotes what you wrote. Which message you press decides what gets quoted; it
 * never decides who the mail goes to (see `seedFor`).
 */

/**
 * The pair that closes every message. Both state an INTENT in the URL and nothing more.
 *
 * They step down to the `sm` control on a pointer, because there is now one pair per message rather
 * than one per thread and the old size repeated marched down the pane. On touch they take the full
 * 44px instead — the same per-callsite override the header buttons use, since a control that
 * repeats is not a reason to make it hard to hit.
 *
 * The accessible name says what each one QUOTES, not who it reaches. "Reply to Kate" would assert
 * a recipient this deliberately does not use — pressing Reply under your own message quotes you and
 * still addresses the other party — and a screen-reader user would be the only one told otherwise.
 *
 * Reply all appears only when it would reach someone Reply would not (`replyAllCc`). A third button
 * that produces the identical message is a choice with no answer, and on the two-party threads that
 * are most of anyone's mail it would be there every time.
 */
const MessageActions = ({ message, canReplyAll }: { message: Message; canReplyAll: boolean }) => (
  // Both quote the body, so neither is offered until it has arrived: a reply seeded from a
  // message still loading would quote nothing and never notice.
  <div className={cn('mt-4 flex gap-2', message.bodyStatus !== undefined && 'invisible')}>
    <Link
      to="."
      search={withCompose(`reply:${message.id}`)}
      className={cn(buttonClass({ variant: 'secondary', size: 'sm' }), 'h-11 lg:h-7')}
      aria-label={`Reply, quoting ${message.fromName}`}
    >
      <ArrowUUpLeftIcon size={13} />
      Reply
    </Link>
    {canReplyAll && (
      <Link
        to="."
        search={withCompose(`reply-all:${message.id}`)}
        className={cn(buttonClass({ variant: 'ghost', size: 'sm' }), 'h-11 lg:h-7')}
        aria-label={`Reply to all, quoting ${message.fromName}`}
      >
        <ArrowUUpLeftIcon size={13} weight="bold" />
        Reply all
      </Link>
    )}
    <Link
      to="."
      search={withCompose(`forward:${message.id}`)}
      className={cn(buttonClass({ variant: 'ghost', size: 'sm' }), 'h-11 lg:h-7')}
      aria-label={`Forward the message from ${message.fromName}`}
    >
      <ArrowUUpRightIcon size={13} />
      Forward
    </Link>
  </div>
);

/** Saves the bytes as the sender's filename. The URL is revoked once the click has been handed off. */
const download = (file: Attachment) => {
  if (file.content === undefined) return;
  const url = URL.createObjectURL(new Blob([file.content]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * Attachments are listed as real objects — kind, name, size — not a paperclip and a guess.
 *
 * Names, like every string a sender wrote, get `dir="auto"`: that isolates the bidi run, so a
 * U+202E in `invoice\u202Efdp.exe` cannot reorder the extension into `.pdf` across the rest of the row.
 */
const AttachmentList = ({ attachments }: { attachments: Attachment[] }) => (
  <ul className="mt-4 flex flex-wrap gap-2">
    {attachments.map(file => (
      <li key={file.name}>
        <button
          type="button"
          onClick={() => download(file)}
          disabled={file.content === undefined}
          className="flex items-center gap-2.5 border border-rule bg-ink px-2.5 py-1.5 text-left font-mono text-2xs transition-colors hover:border-paper-faint disabled:cursor-default disabled:hover:border-rule"
          aria-label={`Download ${file.name}, ${formatBytes(file.size)}`}
        >
          <span className="text-paper-faint">{ATTACHMENT_LABEL[file.kind]}</span>
          <span dir="auto" className="max-w-64 truncate text-paper">
            {file.name}
          </span>
          <span className="text-paper-faint">{formatBytes(file.size)}</span>
          <DownloadSimpleIcon size={12} className="text-paper-faint" />
        </button>
      </li>
    ))}
  </ul>
);

/**
 * `html` is the sender's document in the sandboxed frame; `text` is the sender's own `text/plain`
 * alternative, shown as we show plain mail. Nothing is derived: a message that shipped no text
 * part says so and points at the other mode rather than showing a reduction dressed as one.
 */
type ReadingMode = 'html' | 'text';

/**
 * Paragraphs keep the sender's line breaks (`whitespace-pre-line`) and are bidi-isolated per
 * paragraph. They render directly for plain mail and remain the fail-closed fallback for HTML.
 */
const MessageBody = ({
  message,
  mode,
  onRetry,
}: {
  message: Message;
  mode: ReadingMode;
  onRetry: () => void;
}) => {
  switch (message.bodyStatus) {
    case 'pending':
    case 'loading':
      return <p className="text-paper-dim">Loading…</p>;
    case 'failed':
      return (
        <p className="text-paper-dim">
          Could not load this message.{' '}
          <button
            type="button"
            onClick={onRetry}
            className="text-signal underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      );
    case undefined: {
      const fallback =
        message.body.length === 0 ? (
          <p className="text-paper-dim">(empty message)</p>
        ) : (
          message.body.map((paragraph, index) => (
            <p key={`${message.id}-${index}`} dir="auto" className="whitespace-pre-line">
              {linkify(paragraph)}
            </p>
          ))
        );
      // `hasTextPart === false` is a parsed message whose only body was HTML — including one
      // too large to frame, where `html` is absent and `body` is our reduction. Plain-text mode
      // must not present that reduction as the sender's text, whichever the case.
      if (mode === 'text')
        return message.hasTextPart === false ? (
          <p className="text-paper-dim">
            This message has no plain-text version. Switch to HTML to read it.
          </p>
        ) : (
          fallback
        );
      if (message.html === undefined) return fallback;
      return (
        <HtmlBody
          key={message.id}
          html={message.html}
          fromName={message.fromName}
          inlineImagesTruncated={message.inlineImagesTruncated ?? false}
          fallback={<div className="max-w-[68ch]">{fallback}</div>}
        />
      );
    }
  }
};

const READING_MODES = [
  { id: 'html', Icon: BrowserIcon, label: 'HTML' },
  { id: 'text', Icon: TextAlignLeftIcon, label: 'Plain text' },
] as const satisfies readonly { id: ReadingMode; Icon: Icon; label: string }[];

export const ThreadReader = ({ thread, onClose }: { thread: ThreadState; onClose: () => void }) => {
  const {
    ownedAddresses,
    toggleStar,
    toggleArchive,
    trashThread,
    restoreThread,
    markUnread,
    loadBody,
  } = useMail();
  // One choice for every HTML body, kept like the list layout: which way mail reads best is a
  // fact about the reader, not about the message.
  const [mode, setMode] = useChromePref<ReadingMode>('yozz:reading-mode', 'html', raw =>
    raw === 'text' ? 'text' : 'html',
  );
  const newest = thread.messages.at(-1);
  if (newest === undefined) throw new Error(`Thread ${thread.id} has no messages`);
  // Everything that answers "who wrote to me, and at which of my addresses" must come from the
  // newest message that ARRIVED — not the newest message, which is yours whenever you replied last.
  const inbound = newestInbound(thread, ownedAddresses) ?? newest;
  // A question about the THREAD, not about the message a button sits under: `seedFor` copies the
  // group off the newest message that arrived whichever Reply all you press, so the offer has to
  // be read from the same place or a button would appear that seeds nothing.
  const canReplyAll = replyAllCc(inbound, ownedAddresses).length > 0;
  const { mailbox } = useParams({ strict: false });

  return (
    <article className="flex h-full flex-col bg-ink-sunken">
      <header className="shrink-0 border-b border-rule-soft px-5 pt-4 pb-3">
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleStar(thread.id)}
            // Same mark, same colour as the list: starred is the accent wherever it appears.
            className={cn(
              '-ml-1.5 size-11 shrink-0 lg:size-7',
              thread.isStarred && 'text-signal hover:text-signal',
            )}
            aria-label="Star thread"
            aria-pressed={thread.isStarred}
          >
            <StarIcon size={15} weight={thread.isStarred ? 'fill' : 'regular'} />
          </Button>
          <h1
            dir="auto"
            className="min-w-0 flex-1 pt-1 text-[17px] leading-snug font-medium tracking-[-0.01em] text-paper lg:pt-0"
          >
            {thread.subject}
          </h1>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconSwitch
              label="Reading mode"
              options={READING_MODES}
              value={mode}
              onChange={setMode}
              cellClassName="size-11 lg:size-7"
            />
            {/* Triage closes the reader: the thread you just filed is not the one you are reading,
                and one you marked unread would be read again the moment it stayed open. Opened
                from Trash, a thread offers the one move that gets it out — the row it came from
                offered the same, and a conversation only half in the bin must not lose it. */}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 lg:size-7"
              onClick={() => {
                markUnread(thread.id);
                onClose();
              }}
              aria-label="Mark as unread"
            >
              <EnvelopeSimpleIcon size={15} />
            </Button>
            {mailbox === 'trash' ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 lg:size-7"
                onClick={() => {
                  restoreThread(thread.id);
                  onClose();
                }}
                aria-label="Restore thread"
              >
                <ArrowCounterClockwiseIcon size={15} />
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 lg:size-7"
                  onClick={() => {
                    toggleArchive(thread.id);
                    onClose();
                  }}
                  aria-label={isArchived(thread) ? 'Move to inbox' : 'Archive thread'}
                >
                  <ArchiveIcon size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 lg:size-7"
                  onClick={() => {
                    trashThread(thread.id);
                    onClose();
                  }}
                  aria-label="Delete thread"
                >
                  <TrashIcon size={15} />
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-11 lg:size-7"
              onClick={onClose}
              aria-label="Close message"
            >
              <XIcon size={15} />
            </Button>
          </div>
        </div>

        <p className="mt-1.5 flex items-center gap-1.5 pl-8 font-mono text-2xs text-paper-faint lg:pl-7">
          <span aria-hidden className="text-paper-dim">
            {markOf(thread.accountId)}
          </span>
          <span>delivered to {inbound.toAddress}</span>
          {/* The same count the list row carries, on the same rule: only above one, because "1
              message" on a single message is a label for nothing. It earns its place here now that
              the reader is a stack of messages you scroll rather than one body — it says how far
              down this goes before you start. */}
          {thread.messages.length > 1 && (
            <>
              <span aria-hidden>·</span>
              <span>{thread.messages.length} messages</span>
            </>
          )}
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {thread.messages.map((message, index) => (
          <div
            key={message.id}
            className={cn('px-5 pt-4 pb-6', index > 0 && 'border-t border-rule-soft')}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p dir="auto" className="text-base font-medium text-paper">
                {message.fromName}
                <span className="ml-2 font-mono text-2xs font-normal text-paper-faint">
                  {message.fromAddress}
                </span>
              </p>
              <p className="font-mono text-2xs text-paper-faint">{fullTime(message.at)}</p>
            </div>

            {/* Body copy is the one place in this app that is READ rather than scanned, so it
                gets full-strength ink and a measure capped near 68 characters. An HTML body is
                the sender's own document instead: it gets the width its 600px-grid templates
                assume, and its type is set inside the frame, not here. */}
            <div
              className={cn(
                'mt-3 space-y-3',
                message.html !== undefined && mode === 'html'
                  ? 'max-w-2xl'
                  : 'max-w-[68ch] text-[13.5px] leading-[1.65] text-paper',
              )}
            >
              <MessageBody
                message={message}
                mode={mode}
                onRetry={() => loadBody(thread.id, message.id)}
              />
            </div>

            {message.attachments !== undefined && message.attachments.length > 0 && (
              <AttachmentList attachments={message.attachments} />
            )}

            <MessageActions message={message} canReplyAll={canReplyAll} />
          </div>
        ))}
      </div>
    </article>
  );
};
