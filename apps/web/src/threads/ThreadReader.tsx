import { Popover } from '@base-ui/react/popover';
import { cn } from '@fishballapps/cn';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  BrowserIcon,
  CaretDownIcon,
  DownloadSimpleIcon,
  EnvelopeSimpleIcon,
  type Icon,
  NotePencilIcon,
  StarIcon,
  TextAlignLeftIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Link, useParams } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { marksOf } from '../addresses/record';
import { replyAllCc, withCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Button, buttonClass } from '../ui/Button';
import { useChromePref } from '../ui/chrome';
import { IconSwitch } from '../ui/IconSwitch';
import { fullTime } from '../ui/time';
import { ATTACHMENT_LABEL, formatBytes } from './attachments';
import { HtmlBody } from './HtmlBody';
import { linkify } from './linkify';
import type { ThreadState } from './thread';
import {
  type Attachment,
  addresseesOf,
  inboxesOf,
  isArchived,
  type Message,
  newestInbound,
  type Recipient,
} from './thread';

/**
 * Every message says who it was written to under its From line, the way Gmail does: one "to me,
 * Alice" line whose caret opens the envelope. Reply and Forward sit under every message; which one
 * you press decides what is quoted, never who the mail goes to (`seedFor`).
 */

/** Name in sans, address in mono; your own addresses at full ink, so you find yourself on a long list. */
const RecipientList = ({
  recipients,
  ownedAddresses,
}: {
  recipients: readonly Recipient[];
  ownedAddresses: readonly string[];
}) =>
  recipients.map((recipient, index) => {
    const isYou = ownedAddresses.some(
      owned => owned.toLowerCase() === recipient.address.toLowerCase(),
    );
    return (
      <span key={`${index}-${recipient.address}`}>
        {/* One unit per person: it moves to the next line whole, and breaks inside only when it is
            wider than the line. `dir="auto"` keeps a right-to-left name from reordering its
            neighbours. */}
        <span dir="auto" className="inline-block max-w-full align-top [overflow-wrap:anywhere]">
          {recipient.name !== undefined && (
            <span className={isYou ? 'text-paper' : 'text-paper-dim'}>{recipient.name} </span>
          )}
          <span
            className={cn(
              'font-mono',
              isYou ? 'text-paper' : recipient.name === undefined && 'text-paper-dim',
            )}
          >
            {recipient.address}
          </span>
          {index < recipients.length - 1 ? ',' : ''}
        </span>{' '}
      </span>
    );
  });

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="contents">
    <dt className="label-rule">{term}</dt>
    <dd className="min-w-0 text-paper-faint">{children}</dd>
  </div>
);

/**
 * "to me, Alice ▾": To and Cc on one line, the whole line the trigger. The panel answers who and
 * where; the date and subject are already on screen in full.
 */
const MessageDetails = ({
  message,
  ownedAddresses,
}: {
  message: Message;
  ownedAddresses: readonly string[];
}) => {
  const addressees = addresseesOf(message, ownedAddresses);
  const inboxes = inboxesOf(message);
  const summary =
    addressees.length === 0
      ? 'undisclosed recipients'
      : addressees.map(entry => (entry === 'me' ? 'me' : (entry.name ?? entry.address))).join(', ');

  return (
    <Popover.Root>
      <Popover.Trigger
        // 44px tall on touch; the negative margin keeps the line box at the text's height.
        className="group -my-3.5 flex max-w-full items-center gap-1 py-3.5 text-left text-2xs text-paper-faint lg:my-0 lg:py-0"
        aria-label={`To ${summary}. Show details`}
      >
        <span className="truncate">
          to{' '}
          {addressees.length === 0
            ? summary
            : addressees.map((entry, index) => {
                const addressee = (() => {
                  if (entry === 'me') return <span className="text-paper-dim">me</span>;
                  if (entry.name !== undefined) {
                    return <bdi className="text-paper-dim">{entry.name}</bdi>;
                  }
                  return <span className="font-mono text-paper-dim">{entry.address}</span>;
                })();
                return (
                  <Fragment key={entry === 'me' ? 'me' : entry.address}>
                    {index > 0 && ', '}
                    {addressee}
                  </Fragment>
                );
              })}
        </span>
        <CaretDownIcon
          size={11}
          aria-hidden
          className="shrink-0 transition-colors group-hover:text-paper group-data-[popup-open]:text-paper"
        />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={12}
          // Portalled, so it would ride over the reader header once its trigger scrolls away.
          className="z-30 data-[anchor-hidden]:invisible"
        >
          <Popover.Popup
            aria-label="Message details"
            className="max-h-[var(--available-height)] w-[min(36rem,var(--available-width))] overflow-y-auto border border-rule bg-ink-raised px-4 py-3 outline-none"
          >
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-2xs">
              {/* First: across several addresses, which one this landed in is the first question. */}
              {inboxes.length > 0 && (
                <Detail term="inbox">
                  <span className="font-mono text-paper-dim [overflow-wrap:anywhere]">
                    {inboxes.join(', ')}
                  </span>
                </Detail>
              )}
              <Detail term="from">
                <RecipientList
                  recipients={[
                    message.fromName.toLowerCase() === message.fromAddress.toLowerCase()
                      ? { address: message.fromAddress }
                      : { name: message.fromName, address: message.fromAddress },
                  ]}
                  ownedAddresses={ownedAddresses}
                />
              </Detail>
              {message.replyTo !== undefined && (
                <Detail term="reply-to">
                  <RecipientList recipients={message.replyTo} ownedAddresses={ownedAddresses} />
                </Detail>
              )}
              {message.to !== undefined && message.to.length > 0 && (
                <Detail term="to">
                  <RecipientList recipients={message.to} ownedAddresses={ownedAddresses} />
                </Detail>
              )}
              {message.cc !== undefined && message.cc.length > 0 && (
                <Detail term="cc">
                  <RecipientList recipients={message.cc} ownedAddresses={ownedAddresses} />
                </Detail>
              )}
            </dl>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

/**
 * `sm` on a pointer, full 44px on touch. The accessible name says what each quotes, not who it
 * reaches. Reply all appears only when it would reach someone Reply would not (`replyAllCc`).
 */
const MessageActions = ({ message, canReplyAll }: { message: Message; canReplyAll: boolean }) =>
  // An unsent draft is finished in the composer, not replied to.
  message.isDraft === true ? (
    <div className="mt-4 flex gap-2">
      <Link
        to="."
        search={withCompose(`draft:${message.draftKey ?? ''}`)}
        className={cn(buttonClass({ variant: 'secondary', size: 'sm' }), 'h-11 lg:h-7')}
      >
        <NotePencilIcon size={13} />
        Edit draft
      </Link>
    </div>
  ) : (
    // Both quote the body, so neither is offered until it has arrived.
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

/** Saves the bytes as the sender's filename; the URL is revoked once the click has been handed off. */
const download = (file: Attachment) => {
  if (file.content === undefined) return;
  const url = URL.createObjectURL(new Blob([file.content]));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** `dir="auto"` isolates the bidi run, so a U+202E in `invoice\u202Efdp.exe` cannot reorder the extension. */
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

/** `html` is the sender's document; `text` is the sender's own `text/plain` part. Nothing is derived. */
type ReadingMode = 'html' | 'text';

/** Paragraphs keep the sender's line breaks and are bidi-isolated; the fail-closed fallback for HTML. */
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
      // `hasTextPart === false` includes an HTML message too large to frame, where `body` is our reduction.
      if (mode === 'text') {
        return message.hasTextPart === false ? (
          <p className="text-paper-dim">
            This message has no plain-text version. Switch to HTML to read it.
          </p>
        ) : (
          fallback
        );
      }
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

export const ThreadReader = ({
  thread,
  onClose,
  onTriaged,
}: {
  thread: ThreadState;
  onClose: () => void;
  /** After a move the store accepted, the next thread in the list is up. */
  onTriaged: () => void;
}) => {
  const {
    ownedAddresses,
    toggleStar,
    toggleArchive,
    trashThread,
    restoreThread,
    markUnread,
    loadBody,
  } = useMail();
  // One choice for every HTML body, kept like the list layout.
  const [mode, setMode] = useChromePref<ReadingMode>('yozz:reading-mode', 'html', raw =>
    raw === 'text' ? 'text' : 'html',
  );
  const newest = thread.messages.at(-1);
  if (newest === undefined) throw new Error(`Thread ${thread.id} has no messages`);
  // From the newest message that arrived, not the newest message, which is yours whenever you replied last.
  const inbound = newestInbound(thread, ownedAddresses) ?? newest;
  // Read from the same place `seedFor` reads, or a button would appear that seeds nothing.
  const canReplyAll = replyAllCc(inbound, ownedAddresses).length > 0;
  const { mailbox } = useParams({ strict: false });

  return (
    <article className="flex h-full flex-col bg-ink-sunken">
      <header className="shrink-0 border-b border-rule-soft px-5 pt-4 pb-3">
        {/* Below `lg` the toolbar takes its own row under the subject: its six 44px targets left
            the subject a few characters on a phone. Wrapping rather than reordering keeps the
            focus order the same as the reading order. */}
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1 lg:flex-nowrap">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => toggleStar(thread.id)}
            // Same mark, same colour as the list.
            className={cn(
              '-ml-1.5 size-11 shrink-0 lg:size-7',
              thread.isStarred && 'text-signal hover:text-signal',
            )}
            aria-label="Star thread"
            aria-pressed={thread.isStarred}
          >
            <StarIcon size={15} weight={thread.isStarred ? 'fill' : 'regular'} />
          </Button>
          {/* The first line centres on the star's 44px touch target, and on its 28px one above `lg`. */}
          <div className="min-w-0 flex-1 pt-2.5 lg:pt-0.5">
            <h1
              dir="auto"
              className="text-[17px] leading-snug font-medium tracking-[-0.01em] text-paper"
            >
              {thread.subject}
            </h1>
            {/* The same count the list row carries, on the same rule: only above one, because "1
                message" on a single message is a label for nothing. It says how far down the
                stack goes before you start, beside the marks of every account the conversation
                spans; each message's own IN line says where that one landed. */}
            {thread.messages.length > 1 && (
              <p className="mt-1.5 flex items-center gap-1.5 font-mono text-2xs text-paper-faint">
                <span aria-hidden className="text-paper-dim">
                  {marksOf(thread.accounts)}
                </span>
                <span>{thread.messages.length} messages</span>
              </p>
            )}
          </div>
          <div className="-mr-1.5 flex w-full shrink-0 items-center justify-end gap-0.5 lg:mr-0 lg:w-auto">
            <IconSwitch
              label="Reading mode"
              options={READING_MODES}
              value={mode}
              onChange={setMode}
              cellClassName="size-11 lg:size-7"
            />
            {/* Filing a thread moves the reader on to the next in the list — the one you just
                filed is not the one you are reading — while marking unread closes it, since it
                would be read again the moment it stayed open. Opened from Trash, a thread offers
                the one move that gets it out — the row it came from offered the same, and a
                conversation only half in the bin must not lose it. */}
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
                  if (restoreThread(thread.id)) onTriaged();
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
                    if (toggleArchive(thread.id)) onTriaged();
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
                    if (trashThread(thread.id)) onTriaged();
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
            {/* A draft has no envelope yet. */}
            {message.to !== undefined && (
              <MessageDetails message={message} ownedAddresses={ownedAddresses} />
            )}

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
