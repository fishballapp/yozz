import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowUUpLeftIcon,
  ArrowUUpRightIcon,
  BellSlashIcon,
  CaretDownIcon,
  CodeIcon,
  DotsThreeIcon,
  EnvelopeSimpleIcon,
  type Icon,
  MailboxIcon,
  NotePencilIcon,
  StarIcon,
  TextAlignLeftIcon,
  TrashIcon,
  WarningOctagonIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Link, useSearch } from '@tanstack/react-router';
import { replyAllCc } from '@yozz.app/mail/compose/seed';
import { movesOffered } from '@yozz.app/mail/threads/reconcile';
import type { SenderCheck, ThreadState } from '@yozz.app/mail/threads/thread';
import {
  addresseesOf,
  inboxesOf,
  isOnServer,
  type Message,
  newestInbound,
  type Recipient,
} from '@yozz.app/mail/threads/thread';
import { fullTime } from '@yozz.app/mail/time';
import { cn } from 'cn';
import { Fragment, type ReactNode, useId, useState } from 'react';
import { type ComposeIntent, withCompose } from '../compose/intent';
import { useMail } from '../store/MailProvider';
import { Button, buttonClass } from '../ui/Button';
import { useChromePref, useMediaQuery } from '../ui/chrome';
import { IconSwitch } from '../ui/IconSwitch';
import { reportProblem } from '../ui/Toast';
import { Tooltip } from '../ui/Tooltip';
import { AttachmentList } from './AttachmentList';
import { HtmlBody } from './HtmlBody';
import { JUNK_COPY } from './junk-copy';
import { linkify } from './linkify';
import { unsubscribeActionOf } from './unsubscribe-action';
import { UNSUBSCRIBE_COPY } from './unsubscribe-copy';

/**
 * Every message says who it was written to under its From line, the way Gmail does: one "to me,
 * Alice" line whose caret opens the envelope. Reply, Reply all and Forward sit under the last
 * message; an earlier one offers the same three from a menu on its header line. Which one you press
 * decides what is quoted, never who the mail goes to (`seedFor`).
 */

/** Body copy is READ, not scanned: full ink, a measure of about 75 letters, larger on a phone held further away. */
const PROSE_CLASS = 'max-w-[60ch] text-[16px]/[1.55] text-paper lg:text-[15px]/[1.6]';

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

/** What the check of who signed a message has to say; a check still under way says so, not that it failed. */
const SignedBy = ({ check }: { check: SenderCheck }) => {
  if (check.status === 'checking') return 'checking…';
  if (check.status === 'unverified') return "couldn't be verified";
  return (
    <span className="font-mono text-paper-dim [overflow-wrap:anywhere]">{check.signedBy}</span>
  );
};

/** Who and where, as one table: the popover and the inline block both show these rows. */
const DetailsTable = ({
  message,
  ownedAddresses,
}: {
  message: Message;
  ownedAddresses: readonly string[];
}) => {
  const inboxes = inboxesOf(message);

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-2xs">
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
      {/* Received mail whose body has arrived: your own copies and drafts have no sender to check. */}
      {inboxes.length > 0 && message.senderCheck !== undefined && (
        <Detail term="signed by">
          <SignedBy check={message.senderCheck} />
        </Detail>
      )}
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
  );
};

/**
 * "to me, Alice ▾": To and Cc on one line, the whole line the trigger. The details answer who and
 * where; the date and subject are already on screen in full. From `lg` up they float in a popover;
 * on a phone they open inline, pushing the body down, since a popover would cover the message it
 * describes.
 */
const MessageDetails = ({
  message,
  ownedAddresses,
  pane,
}: {
  message: Message;
  ownedAddresses: readonly string[];
  /** The reader's scroll area, which the popover stays inside rather than spilling over the list. */
  pane: HTMLElement | null;
}) => {
  const isWide = useMediaQuery('(min-width: 64rem)');
  const [isOpen, setIsOpen] = useState(false);
  const regionId = useId();
  const addressees = addresseesOf(message, ownedAddresses);
  // "me" is enough while there is one address to be; with several, which one it reached is the fact.
  const yourAddress =
    ownedAddresses.length > 1
      ? [...(message.to ?? []), ...(message.cc ?? [])].find(({ address }) =>
          ownedAddresses.some(owned => owned.toLowerCase() === address.toLowerCase()),
        )?.address
      : undefined;
  const summary =
    addressees.length === 0
      ? 'undisclosed recipients'
      : addressees
          .map(entry => {
            if (entry === 'me') return yourAddress ?? 'me';
            return entry.name ?? entry.address;
          })
          .join(', ');
  const label = `To ${summary}. Details`;
  const toLine = (
    <span className="truncate">
      to{' '}
      {addressees.length === 0
        ? summary
        : addressees.map((entry, index) => {
            const addressee = (() => {
              if (entry === 'me' && yourAddress !== undefined) {
                return <span className="font-mono text-paper-dim">{yourAddress}</span>;
              }
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
  );
  const triggerClass =
    'group flex max-w-full items-center gap-1 text-left text-2xs text-paper-faint';

  if (!isWide) {
    return (
      <>
        <button
          type="button"
          // 44px tall; the negative margin keeps the line box at the text's height.
          className={cn(triggerClass, '-my-3.5 py-3.5')}
          aria-label={label}
          aria-expanded={isOpen}
          aria-controls={regionId}
          onClick={() => setIsOpen(wasOpen => !wasOpen)}
        >
          {toLine}
          <CaretDownIcon
            size={11}
            aria-hidden
            className="shrink-0 transition-transform group-aria-expanded:rotate-180 group-aria-expanded:text-paper"
          />
        </button>
        <section
          id={regionId}
          aria-label="Message details"
          hidden={!isOpen}
          className="mt-4 border border-rule bg-ink-raised px-4 py-3"
        >
          <DetailsTable message={message} ownedAddresses={ownedAddresses} />
        </section>
      </>
    );
  }

  return (
    <Popover.Root>
      <Popover.Trigger className={triggerClass} aria-label={label}>
        {toLine}
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
          collisionBoundary={pane ?? 'clipping-ancestors'}
          // Slides only as far as the pane's edge forces it; the default flips to align its right
          // edge with the trigger's, hanging the panel back over the message list.
          collisionAvoidance={{ align: 'shift' }}
          // Portalled, so it would ride over the reader header once its trigger scrolls away.
          className="z-30 data-[anchor-hidden]:invisible"
        >
          <Popover.Popup
            aria-label="Message details"
            className="max-h-[var(--available-height)] w-max max-w-[min(36rem,var(--available-width))] overflow-y-auto border border-rule bg-ink-raised px-4 py-3 outline-none"
          >
            <DetailsTable message={message} ownedAddresses={ownedAddresses} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

/**
 * The three ways to answer a message, as one list for the buttons under the last message and the
 * menu on an earlier one. The accessible name says what each quotes, not who it reaches. Reply all
 * appears only when it would reach someone Reply would not (`replyAllCc`).
 */
const repliesTo = (message: Message, canReplyAll: boolean) =>
  [
    {
      id: 'reply',
      intent: `reply:${message.id}`,
      label: 'Reply',
      ariaLabel: `Reply, quoting ${message.fromName}`,
      Icon: ArrowUUpLeftIcon,
      weight: 'regular',
    },
    ...(canReplyAll
      ? [
          {
            id: 'reply-all',
            intent: `reply-all:${message.id}`,
            label: 'Reply all',
            ariaLabel: `Reply to all, quoting ${message.fromName}`,
            Icon: ArrowUUpLeftIcon,
            weight: 'bold',
          } as const,
        ]
      : []),
    {
      id: 'forward',
      intent: `forward:${message.id}`,
      label: 'Forward',
      ariaLabel: `Forward the message from ${message.fromName}`,
      Icon: ArrowUUpRightIcon,
      weight: 'regular',
    },
  ] as const satisfies readonly {
    id: string;
    intent: ComposeIntent;
    label: string;
    ariaLabel: string;
    Icon: Icon;
    weight: 'regular' | 'bold';
  }[];

/** An earlier message's replies: one icon on its header line, so a long thread is not a column of buttons. */
const MoreReplies = ({ message, canReplyAll }: { message: Message; canReplyAll: boolean }) => (
  <Menu.Root>
    <Tooltip label="Reply or forward">
      <Menu.Trigger
        aria-label={`Reply to or forward the message from ${message.fromName}`}
        className={cn(
          buttonClass({ variant: 'ghost', size: 'icon' }),
          'size-11 data-[popup-open]:bg-ink-hover data-[popup-open]:text-paper lg:size-7',
        )}
      >
        <DotsThreeIcon size={15} weight="bold" />
      </Menu.Trigger>
    </Tooltip>
    <Menu.Portal>
      <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-30">
        <Menu.Popup className="min-w-40 border border-rule bg-ink-raised py-1 outline-none">
          {repliesTo(message, canReplyAll).map(({ id, intent, label, ariaLabel, Icon, weight }) => (
            <Menu.LinkItem
              key={id}
              closeOnClick
              render={<Link to="." search={withCompose(intent)} aria-label={ariaLabel} />}
              className="flex h-11 items-center gap-2 px-3 text-base text-paper outline-none data-[highlighted]:bg-ink-hover lg:h-8"
            >
              <Icon size={13} weight={weight} />
              {label}
            </Menu.LinkItem>
          ))}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

/**
 * `sm` on a pointer, full 44px on touch. Only the last message carries Reply, Reply all and
 * Forward in full; every message keeps its own Unsubscribe and an unsent draft its Edit draft.
 */
const MessageActions = ({
  message,
  thread,
  canReplyAll,
  isLast,
  canCompose,
}: {
  message: Message;
  thread: ThreadState;
  canReplyAll: boolean;
  isLast: boolean;
  /** False beside an open composer: nothing here may swap the draft being written for another. */
  canCompose: boolean;
}) => {
  // An unsent draft is finished in the composer, not replied to.
  if (message.isDraft === true) {
    if (!canCompose) return null;
    return (
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
    );
  }
  const offered = unsubscribeActionOf(message, thread);
  // The sender's own page opens in a tab; writing to the sender needs the composer.
  const unsubscribe = offered?.kind === 'write-draft' && !canCompose ? null : offered;
  const hasReplies = isLast && canCompose;
  if (!hasReplies && unsubscribe === null) return null;
  const unsubscribeClass = cn(buttonClass({ variant: 'ghost', size: 'sm' }), 'h-11 lg:h-7');
  return (
    // Both quote the body, so neither is offered until it has arrived.
    <div
      className={cn('mt-4 flex flex-wrap gap-2', message.bodyStatus !== undefined && 'invisible')}
    >
      {hasReplies &&
        repliesTo(message, canReplyAll).map(({ id, intent, label, ariaLabel, Icon, weight }) => (
          <Link
            key={id}
            to="."
            search={withCompose(intent)}
            className={cn(
              buttonClass({ variant: id === 'reply' ? 'secondary' : 'ghost', size: 'sm' }),
              'h-11 lg:h-7',
            )}
            aria-label={ariaLabel}
          >
            <Icon size={13} weight={weight} />
            {label}
          </Link>
        ))}
      {unsubscribe?.kind === 'open-link' && (
        // The sender's page, not ours: nothing about this tab goes with the click.
        <a
          href={unsubscribe.href}
          target="_blank"
          rel="noopener noreferrer"
          className={unsubscribeClass}
          aria-label={UNSUBSCRIBE_COPY.action}
        >
          <BellSlashIcon size={13} />
          {UNSUBSCRIBE_COPY.action}
        </a>
      )}
      {unsubscribe?.kind === 'write-draft' && (
        <Link
          to="."
          search={withCompose(`unsubscribe:${message.id}`)}
          className={unsubscribeClass}
          aria-label={UNSUBSCRIBE_COPY.action}
        >
          <BellSlashIcon size={13} />
          {UNSUBSCRIBE_COPY.action}
        </Link>
      )}
    </div>
  );
};

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
    // Not yet read from the device: a cached body lands within a frame or two, so nothing flashes.
    case 'pending':
      return null;
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
          messageId={message.id}
          fromName={message.fromName}
          fromAddress={message.fromAddress}
          senderCheck={message.senderCheck}
          inlineImagesTruncated={message.inlineImagesTruncated ?? false}
          fallback={<div className={cn(PROSE_CLASS, 'space-y-3')}>{fallback}</div>}
        />
      );
    }
  }
};

const READING_MODES = [
  { id: 'html', Icon: CodeIcon, label: 'HTML' },
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
    moveThreadsWithUndo,
    junkFolders,
    markUnread,
    loadBody,
    readStoredFile,
  } = useMail();
  // One choice for every HTML body, kept across reloads like the pane widths.
  const [mode, setMode] = useChromePref<ReadingMode>('yozz:reading-mode', 'html', raw =>
    raw === 'text' ? 'text' : 'html',
  );
  const newest = thread.messages.at(-1);
  if (newest === undefined) throw new Error(`Thread ${thread.id} has no messages`);
  // From the newest message that arrived, not the newest message, which is yours whenever you replied last.
  const inbound = newestInbound(thread, ownedAddresses) ?? newest;
  // Read from the same place `seedFor` reads, or a button would appear that seeds nothing.
  const canReplyAll = replyAllCc(inbound, ownedAddresses).length > 0;
  const moves = movesOffered(thread, junkFolders);
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  // A move the store refused leaves the reader where it is and says why, now or when the server answers.
  const file =
    (move: (threadId: string, onRefused: (reason: string) => void) => boolean, notFiled: string) =>
    () => {
      if (move(thread.id, reason => reportProblem(notFiled, reason))) onTriaged();
    };
  // A star, an unread mark and a move all act on server copies, so a conversation with none offers none.
  const canMark = isOnServer(thread);
  const hasMenu = (index: number) =>
    index < thread.messages.length - 1 && thread.messages[index]?.isDraft !== true;
  const hasHtml = thread.messages.some(message => message.html !== undefined);
  const isWide = useMediaQuery('(min-width: 64rem)');
  // From `lg` an open composer sits beside the reader (a docked reply) or over it, so nothing here
  // may open a second draft in its place. On a phone the composer covers the reader.
  const { compose } = useSearch({ from: '__root__' });
  const canCompose = compose === undefined || !isWide;

  const readingModeSwitch = (
    <IconSwitch
      label="Reading mode"
      options={READING_MODES}
      value={mode}
      onChange={setMode}
      // A 32px box on a phone, its 44px targets reaching past it into the bar's air.
      cellClassName="relative h-8 w-11 after:absolute after:inset-x-0 after:-inset-y-1.5 lg:size-7 lg:after:hidden"
    />
  );

  return (
    <article className="flex h-full flex-col bg-ink-sunken">
      <header className="shrink-0 border-b border-rule-soft">
        {/* What you do to the thread, on a bar of its own: level with the list's search bar above
            `lg`, an app bar under the shell's on a phone. Back leads on a phone, where the reader
            replaces the list; a pane closes from its far corner. Filing a thread moves the reader
            on to the next in the list — the one you just filed is not the one you are reading —
            while marking unread closes it, since it would be read again the moment it stayed
            open. Which moves are offered goes by what the thread holds, wherever it was opened
            from, so a conversation only half in Trash can still be restored. No mark is offered
            on a conversation no server holds a copy of. */}
        <div className="flex h-11 items-center border-b border-rule-soft px-5">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-3.5 size-11 lg:hidden"
            onClick={onClose}
            aria-label="Back to the list"
          >
            <ArrowLeftIcon size={15} />
          </Button>
          {canMark && (
            <>
              <span aria-hidden className="mx-1.5 h-5 w-px bg-rule lg:hidden" />
              <div className="flex items-center gap-0.5 lg:-ml-1.5">
                {moves.canRestore && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={file(restoreThread, 'Thread not restored')}
                    aria-label="Restore thread"
                  >
                    <ArrowCounterClockwiseIcon size={15} />
                  </Button>
                )}
                {(moves.canArchive || moves.canMoveToInbox) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={file(
                      toggleArchive,
                      moves.canArchive ? 'Thread not archived' : 'Thread not moved to inbox',
                    )}
                    aria-label={moves.canArchive ? 'Archive thread' : 'Move to inbox'}
                  >
                    {moves.canArchive ? <ArchiveIcon size={15} /> : <MailboxIcon size={15} />}
                  </Button>
                )}
                {moves.canMoveToJunk && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={file(
                      (threadId, onRefused) =>
                        moveThreadsWithUndo([threadId], 'junk', onRefused).has(threadId),
                      JUNK_COPY.notMovedToJunk,
                    )}
                    aria-label={JUNK_COPY.moveToJunk}
                  >
                    <WarningOctagonIcon size={15} />
                  </Button>
                )}
                {moves.canMoveOutOfJunk && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={file(restoreThread, 'Thread not moved to inbox')}
                    aria-label="Move to inbox"
                  >
                    <MailboxIcon size={15} />
                  </Button>
                )}
                {moves.canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={file(trashThread, 'Thread not deleted')}
                    aria-label="Delete thread"
                  >
                    <TrashIcon size={15} />
                  </Button>
                )}
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
              </div>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="-mr-1.5 ml-auto hidden lg:inline-flex"
            onClick={onClose}
            aria-label="Close message"
          >
            <XIcon size={15} />
          </Button>
          {/* Below `lg` this bar is the screen's top bar. In a reader the next thing to do is
              answer, and the foot's Reply is a whole message away, so the bar's one filled action
              is Reply to the last message (Compose is one Back away, on the list). It is offered
              exactly when the foot's is: not for a draft, and inert until the body has arrived. */}
          <div className="-mr-5 ml-auto flex items-center lg:hidden">
            {hasHtml && !isWide && readingModeSwitch}
            {newest.isDraft !== true && (
              <Tooltip label="Reply">
                <Link
                  to="."
                  search={withCompose(`reply:${newest.id}`)}
                  aria-label="Reply"
                  className={cn(
                    buttonClass({ variant: 'primary', size: 'icon' }),
                    'm-2 shrink-0',
                    newest.bodyStatus !== undefined && 'invisible',
                  )}
                >
                  <ArrowUUpLeftIcon size={15} />
                </Link>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="flex items-start px-5 pb-3 lg:gap-x-2 lg:pt-2">
          {canMark && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => toggleStar(thread.id)}
              // The glyph sits on the content edge, under the bar's first glyph; on a phone its
              // 44px target reaches into the margin. Same mark, same colour as the list.
              className={cn(
                '-mr-1 -ml-3.5 size-11 shrink-0 lg:mr-0 lg:-ml-1.5 lg:size-7',
                thread.isStarred && 'text-signal hover:text-signal',
              )}
              aria-label="Star thread"
              aria-pressed={thread.isStarred}
            >
              <StarIcon size={15} weight={thread.isStarred ? 'fill' : 'regular'} />
            </Button>
          )}
          {/* The first line's capitals centre on the star glyph, in its 44px touch target and in
              its 28px one above `lg`. */}
          <div className="min-w-0 flex-1 pt-3 lg:pt-1">
            <h1
              dir="auto"
              className="text-[17px] leading-snug font-medium tracking-[-0.01em] text-paper"
            >
              {thread.subject}
            </h1>
            {/* The count follows the list row's rule: only above one, because "1 message" on a
                single message labels nothing. */}
            {thread.messages.length > 1 && (
              <p className="mt-2 font-mono text-2xs text-paper-faint">
                {thread.messages.length} messages
              </p>
            )}
          </div>
          {/* How the thread is shown, not something done to it, so it sits with the subject
              rather than on the bar: level with its first line, which wraps beside it. It appears
              once a message has an HTML body to switch away from. Below `lg` the bar holds it. */}
          {hasHtml && isWide && <div className="ml-3">{readingModeSwitch}</div>}
        </div>
      </header>

      <div ref={setPane} className="min-h-0 flex-1 overflow-y-auto">
        {thread.messages.map((message, index) => (
          <div
            key={message.id}
            className={cn('relative px-5 pt-4 pb-6', index > 0 && 'border-t border-rule-soft')}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <p
                dir="auto"
                className={cn('text-base font-medium text-paper', hasMenu(index) && 'pr-9 lg:pr-0')}
              >
                {message.fromName}
                <span className="ml-2 font-mono text-2xs font-normal text-paper-faint">
                  {message.fromAddress}
                </span>
              </p>
              <div className="flex items-center gap-2">
                <p className="font-mono text-2xs text-paper-faint">{fullTime(message.at)}</p>
                {/* The last message's replies sit under it in full. */}
                {hasMenu(index) && canCompose && (
                  // Top right of the message on a phone, where the time has a line of its own; beside
                  // the time from `lg`. Either way its glyph sits on the content edge.
                  <div
                    className={cn(
                      'absolute top-1 right-1.5 lg:static lg:-my-1 lg:-mr-1.5',
                      message.bodyStatus !== undefined && 'invisible',
                    )}
                  >
                    <MoreReplies message={message} canReplyAll={canReplyAll} />
                  </div>
                )}
              </div>
            </div>
            {/* A draft has no envelope yet. */}
            {message.to !== undefined && (
              <MessageDetails message={message} ownedAddresses={ownedAddresses} pane={pane} />
            )}

            {/* Body copy is the one place in this app that is READ rather than scanned, so it
                gets full-strength ink and a measure of about 75 letters. An HTML body is the
                sender's own document instead: it gets the width its 600px-grid templates assume,
                and its type is set inside the frame, not here. */}
            <div
              className={cn(
                'mt-3 space-y-3',
                message.html !== undefined && mode === 'html' ? 'max-w-2xl' : PROSE_CLASS,
              )}
            >
              <MessageBody
                message={message}
                mode={mode}
                onRetry={() => loadBody(thread.id, message.id)}
              />
            </div>

            {message.attachments !== undefined && message.attachments.length > 0 && (
              <AttachmentList attachments={message.attachments} loadFile={readStoredFile} />
            )}

            <MessageActions
              message={message}
              thread={thread}
              canReplyAll={canReplyAll}
              isLast={index === thread.messages.length - 1}
              canCompose={canCompose}
            />
          </div>
        ))}
      </div>
    </article>
  );
};
