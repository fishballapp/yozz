import { Dialog } from '@base-ui/react/dialog';
import {
  ArrowLeftIcon,
  EyeIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { type DraftFile, MAX_ATTACHMENT_BYTES } from '@yozz.app/mail/compose/draft';
import type { DeleteOutcome } from '@yozz.app/mail/compose/draft-vault';
import { seedFor } from '@yozz.app/mail/compose/seed';
import { describeMailFailure } from '@yozz.app/mail/describe-failure';
import { savedName } from '@yozz.app/mail/threads/attachment-content';
import { cn } from 'cn';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useComposer, useMail } from '../store/MailProvider';
import type { LoadStoredFile } from '../threads/AttachmentList';
import { ATTACHMENT_LABEL, formatBytes } from '../threads/attachments';
import { useIsMounted, useSaveAttachment } from '../threads/save-attachment';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { isDemo, useMediaQuery } from '../ui/chrome';
import { Input } from '../ui/Field';
import { reportProblem, toast } from '../ui/Toast';
import { Tooltip } from '../ui/Tooltip';
import { useVault } from '../vault/session';
import type { SessionEnded } from '../vault/unlock';
import { DraftPreview, MarkdownCheatSheet } from './DraftPreview';
import { readAttachments, type SendReport } from './draft';
import { FromSwitch } from './FromSwitch';
import {
  answersMessage,
  composeTitleOf,
  DISCARD_WARNING,
  draftKeyOfIntent,
  seedRequestOf,
  withCompose,
  withoutCompose,
} from './intent';

/**
 * `?compose=` says whether the composer is open and the store holds the text; the store follows the
 * URL, and this is the only place that seeds a draft. See DECISIONS.md.
 */

const FieldLabel = ({ children, htmlFor }: { children: string; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className="label-rule flex w-20 shrink-0 items-center pl-4">
    {children}
  </label>
);

/** A send outlives the composer, so its result is a toast. None of these time out. */
const reportSend = (settled: Promise<SendReport>, reopen: (draftKey: string) => void) => {
  const id = toast.add({ title: 'Sending…', timeout: 0 });
  void settled.then(report => {
    if (report.state === 'ended') {
      toast.close(id);
      return;
    }
    if (report.state === 'sent') {
      toast.update(id, { title: 'Sent', timeout: 4000 });
      return;
    }
    if (report.state === 'sent-with-caveat') {
      toast.update(id, {
        title: 'Sent',
        description: report.detail,
        timeout: 0,
        priority: 'high',
      });
      return;
    }
    if (report.state === 'unsettled') {
      // Neither "Sent" nor "Not sent": nobody knows which.
      toast.update(id, {
        title: 'Send unfinished',
        description: report.detail,
        timeout: 0,
        priority: 'high',
      });
      return;
    }
    toast.update(id, {
      title: 'Not sent',
      description: report.detail,
      timeout: 0,
      priority: 'high',
      // Nothing else on screen knows which draft this was.
      // Closed too: it stays until told otherwise, and would sit over the composer it reopens.
      actionProps: {
        children: 'Reopen',
        onClick: () => {
          toast.close(id);
          reopen(report.draftKey);
        },
      },
    });
  });
};

/** What the banner says of a send on the open draft. */
const SEND_STATE_NOTICE = {
  sending: 'Sending — this draft is frozen until it finishes.',
  unconfirmed: 'This may already have been sent.',
  accepted: 'This was sent, but could not be saved to Sent.',
} as const;

/** Every refusal a discard can meet. The composer has closed, so each says where the draft is. */
const DISCARD_REFUSALS: Record<Exclude<DeleteOutcome['outcome'], 'deleted' | 'absent'>, string> = {
  conflict: 'Another device changed it, so it is still in Drafts.',
  sending: 'Its send has not settled, so it is still in Drafts.',
  offline: 'YOZZ could not be reached, so it is still in Drafts.',
};

/** Discard closes the composer before the vault answers, so a refusal is a toast. */
const reportDiscard = async (discarded: Promise<DeleteOutcome | SessionEnded>) => {
  const { outcome } = await discarded;
  if (outcome === 'deleted' || outcome === 'absent' || outcome === 'ended') return;
  reportProblem('Draft not discarded', DISCARD_REFUSALS[outcome]);
};

/** One sentence under the chips, for what a chip's own word can't say. */
const uploadProblemOf = (files: readonly DraftFile[]): string | null => {
  // ponytail: no next step to offer, since nobody can free storage on demand. Accepted until the
  // first full account: docs/attachment-storage.md, "Accepted".
  if (files.some(({ upload }) => upload === 'storage-full')) {
    return 'Failed to upload. Your file storage is full (1 GB).';
  }
  return files.some(({ upload }) => upload === 'failed')
    ? 'Failed to upload. Retry or remove the file.'
    : null;
};

const UPLOAD_WORDS: Record<Exclude<DraftFile['upload'], 'uploaded'>, string> = {
  uploading: 'Uploading…',
  failed: 'Upload failed',
  'storage-full': 'Storage full',
};

/**
 * A file on the open draft: uploading, failed with a retry, or stored. A stored one opens by
 * downloading, from this tab's bytes or from R2 on any other device.
 */
const DraftFileChip = ({
  file,
  isFrozen,
  loadFile,
  onSave,
  onRemove,
  onRetry,
}: {
  file: DraftFile;
  /** A send holds the draft, so its files can't change. */
  isFrozen: boolean;
  loadFile: LoadStoredFile;
  /** Saves the bytes, asking first when they carry notes: a forward brings a received file here. */
  onSave: (file: DraftFile & { content: Uint8Array<ArrayBuffer> }) => void;
  onRemove: () => void;
  onRetry: () => void;
}) => {
  const name = savedName(file.name);
  const [isDownloading, setIsDownloading] = useState(false);
  const isMounted = useIsMounted();
  const [hasDownloadFailed, setHasDownloadFailed] = useState(false);
  const facts = (
    <>
      <span className="text-paper-faint">{ATTACHMENT_LABEL[file.kind]}</span>
      <span dir="auto" className="max-w-56 truncate text-paper">
        {name}
      </span>
      <span className="text-paper-faint">{formatBytes(file.size)}</span>
    </>
  );
  return (
    <li className="flex items-center gap-2 bg-ink px-2 py-1 font-mono text-2xs text-paper-dim">
      {file.upload === 'uploaded' ? (
        <button
          type="button"
          disabled={isDownloading}
          onClick={async () => {
            setIsDownloading(true);
            setHasDownloadFailed(false);
            try {
              const content = file.content ?? (await loadFile(file.id));
              // Removed, closed or locked while it loaded: nothing is saved or asked.
              if (!isMounted()) return;
              if (content === null) throw new Error(`${file.id} is gone`);
              onSave({ ...file, content });
            } catch {
              setHasDownloadFailed(true);
            } finally {
              setIsDownloading(false);
            }
          }}
          className="flex items-center gap-2 -outline-offset-2 hover:text-paper"
          aria-label={`Download ${name}, ${formatBytes(file.size)}`}
        >
          {facts}
        </button>
      ) : (
        facts
      )}
      {isDownloading && <span className="text-paper-faint">Downloading…</span>}
      {hasDownloadFailed && <span className="text-danger">Couldn’t download</span>}
      {file.upload !== 'uploaded' && (
        <span
          role={file.upload === 'uploading' ? 'status' : undefined}
          className={file.upload === 'uploading' ? 'text-paper-faint' : 'text-danger'}
        >
          {UPLOAD_WORDS[file.upload]}
        </span>
      )}
      {(file.upload === 'failed' || file.upload === 'storage-full') &&
        file.content !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="-outline-offset-2 text-paper underline underline-offset-2 hover:text-signal"
            aria-label={`Retry ${name}`}
          >
            Retry
          </button>
        )}
      {!isFrozen && (
        <Tooltip label={`Remove ${name}`}>
          <button
            type="button"
            onClick={onRemove}
            className="-m-1 flex size-6 items-center justify-center -outline-offset-2 text-paper-faint hover:text-paper"
            aria-label={`Remove ${name}`}
          >
            <XIcon size={11} />
          </button>
        </Tooltip>
      )}
    </li>
  );
};

/**
 * A draft's file chips, and the download question they ask. The question lives here, so it dies
 * with the draft: nothing is held after it closes, its session changes or the vault locks.
 */
const DraftFiles = ({
  files,
  isFrozen,
  loadFile,
  onRemove,
  onRetry,
  uploadProblem,
}: {
  files: readonly DraftFile[];
  isFrozen: boolean;
  loadFile: LoadStoredFile;
  onRemove: (fileId: string) => void;
  onRetry: (fileId: string) => void;
  uploadProblem: string | null;
}) => {
  const { save, dialog } = useSaveAttachment();
  return (
    <div className="shrink-0 border-t border-rule-soft px-4 py-2.5">
      {dialog}
      <ul className="flex flex-wrap gap-2">
        {files.map(file => (
          <DraftFileChip
            key={file.id}
            file={file}
            isFrozen={isFrozen}
            loadFile={loadFile}
            onSave={save}
            onRemove={() => onRemove(file.id)}
            onRetry={() => onRetry(file.id)}
          />
        ))}
      </ul>
      {uploadProblem !== null && (
        <p className="mt-2 text-base text-danger" role="alert">
          {uploadProblem}
        </p>
      )}
    </div>
  );
};

/**
 * Where the reader pane starts, which is how wide a docked composer is: it covers the rail and the
 * list and stops at the message it answers. Measured, since the list can render narrower than its
 * stored width. `null` with no reader pane on screen, which means not docked.
 */
const useReaderPaneLeft = (isWanted: boolean): number | null => {
  const [left, setLeft] = useState<number | null>(null);
  // A route can mount or drop the pane under an open composer.
  const pathname = useLocation({ select: location => location.pathname });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` re-finds the pane.
  useLayoutEffect(() => {
    if (!isWanted) {
      setLeft(null);
      return;
    }
    const pane = document.querySelector('[data-reader-pane]');
    const measure = () => setLeft(pane?.getBoundingClientRect().left ?? null);
    measure();
    if (pane === null) return;
    // The body for the window, the pane for the list's resizer.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [isWanted, pathname]);
  return left;
};

export const Compose = () => {
  const { compose } = useSearch({ from: '__root__' });
  const navigate = useNavigate();
  const {
    draft,
    seedDraft,
    updateDraft,
    send,
    attach,
    detach,
    retryUpload,
    draftConflict,
    draftError,
    resolveDraftConflict,
    openSendState,
    isOpenDraftFrozen,
    isOpenSendOver,
    sendAgain,
    finishWithoutCopy,
    backToEditing,
    discardDraft,
  } = useComposer();
  const { threads, identities, ownedAddresses, drafts, watchSession, readStoredFile } = useMail();
  // `to: '.'` only drops the param. `replace`, or Back after closing re-opened a blank draft.
  const close = () => {
    void navigate({ to: '.', search: withoutCompose, replace: true });
  };

  // Its send ended while it was on screen, so there is nothing left here to write or send.
  useEffect(() => {
    if (isOpenSendOver) void navigate({ to: '.', search: withoutCompose, replace: true });
  }, [isOpenSendOver, navigate]);

  /** Puts a refused send back in front of the person, by key. */
  const reopenDraft = (draftKey: string) => {
    void navigate({ to: '.', search: withCompose(`draft:${draftKey}`), replace: true });
  };

  // The URL → store sync, guarded by the intent it last acted on: the store values change on every keystroke.
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingReads, setPendingReads] = useState(0);
  // Cc and Bcc are folded away until asked for; a reply-all opens with them out.
  const [showCopies, setShowCopies] = useState(false);
  // Write, then Preview, then Send: Send is only offered on the message as it will be read.
  const [step, setStep] = useState<'write' | 'preview'>('write');
  // Above the vault gate, so on screen while the session resumes; the seed waits for one.
  const { session } = useVault();
  const canSeed = isDemo() || session !== null;
  const seedKey = `${compose ?? ''}\0${session?.userId ?? ''}`;
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (seeded.current === seedKey || !canSeed) return;
    const request = compose === undefined ? null : seedRequestOf(compose);
    const seed = request === null ? {} : seedFor(request, threads, identities, ownedAddresses);
    // A referenced intent is not marked seeded until its message has loaded. A `draft:` intent
    // gets nothing from `seedFor` by design; its content is the vault record's.
    if (request !== null && Object.keys(seed).length === 0) return;
    const draftKey = compose === undefined ? null : draftKeyOfIntent(compose);
    // The same wait for a `draft:` intent: the records load after unlock.
    if (draftKey !== null && !drafts.some(candidate => candidate.draftKey === draftKey)) return;
    seeded.current = seedKey;
    setSendError(null);
    // Closing changes the intent too, so this also puts a closed composer back on Write.
    setStep('write');
    const opened = seedDraft(compose, seed);
    setShowCopies(opened !== null && (opened.cc !== '' || opened.bcc !== ''));
  }, [compose, seedKey, canSeed, seedDraft, threads, identities, ownedAddresses, drafts]);

  const fileInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const fromTrigger = useRef<HTMLButtonElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewContent = useRef<HTMLDivElement>(null);

  // You write above a quote, so a reply starts at position 0; a message with no From chosen starts
  // at From, and a forward, whose From is set, in To. Once per opening: a later pick or edit never
  // moves the caret.
  const isOpen = draft !== null;
  // Against the vault's addresses, not merely non-empty: a removed address can't send either.
  const selectedIdentity = identities.find(identity => identity.address === draft?.identityId);
  const hasFrom = selectedIdentity !== undefined;
  // A forward has a quote but no recipient yet.
  const startedAsReply = (draft?.startedAsReply ?? false) && (draft?.to ?? '') !== '';
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === seedKey) return;
    // On a cold load the draft can open before the addresses do, while From is still the
    // disabled stand-in with nothing to focus.
    if (!hasFrom && identities.length === 0) return;
    const frame = requestAnimationFrame(() => {
      // Marked here, not before: a re-render that cancels this frame must leave it to the next.
      focusedFor.current = seedKey;
      // Someone who clicked into a field while the addresses loaded is already writing.
      const active = document.activeElement;
      if (
        active?.closest('[role="dialog"]') &&
        active.matches('input, textarea, [role="combobox"]')
      ) {
        return;
      }
      if (!hasFrom) {
        fromTrigger.current?.focus();
        return;
      }
      if (startedAsReply) {
        bodyInput.current?.focus();
        bodyInput.current?.setSelectionRange(0, 0);
        return;
      }
      toInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, seedKey, startedAsReply, hasFrom, identities.length]);

  /** Swaps the step in place, and puts focus where the step change left the person. */
  const showStep = (next: 'write' | 'preview') => {
    setSendError(null);
    flushSync(() => setStep(next));
    (next === 'preview' ? previewContent : previewButton).current?.focus();
  };

  /** Send, and a takeover, which goes on the same way once it is claimed. */
  const pressSend = (press: () => Promise<Awaited<ReturnType<typeof send>> | null>) => {
    // A lock or a sign-in during the claim hands this composer to the next
    // session: its draft is not closed, and none of this send is said in it.
    const isCurrent = watchSession();
    const identityId = draft?.identityId ?? '';
    void (async () => {
      setIsSending(true);
      setSendError(null);
      try {
        const claimed = await press();
        // Refused for a send still running, which the banner now says.
        if (claimed === null || !isCurrent()) return;
        if (!claimed.ok) {
          const host =
            identities.find(identity => identity.address === identityId)?.smtp.host ?? identityId;
          setSendError(describeMailFailure(claimed.error, host));
          return;
        }
        // The bytes are frozen; the rest of the send outlives this dialog.
        close();
        reportSend(claimed.value.settled, reopenDraft);
      } catch (err) {
        if (isCurrent()) {
          setSendError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsSending(false);
      }
    })();
  };

  const uploadProblem = uploadProblemOf(draft?.attachments ?? []);
  // A Bcc-only send is a real message.
  const isMissingRecipient =
    draft !== null && [draft.to, draft.cc, draft.bcc].every(field => field.trim() === '');
  const canSend =
    !isSending && !isOpenDraftFrozen && pendingReads === 0 && hasFrom && !isMissingRecipient;
  // Only what the person can fix by going Back; a frozen draft is the banner's to explain.
  const missingForSend = (() => {
    if (isSending || isOpenDraftFrozen) return null;
    if (!hasFrom && isMissingRecipient) return 'Choose a From address and add a recipient to send.';
    if (!hasFrom) return 'Choose a From address to send.';
    if (isMissingRecipient) return 'Add a recipient to send.';
    return null;
  })();
  const sendLabel = (() => {
    if (!isSending) return 'Send';
    return draft?.attachments.some(({ upload }) => upload === 'uploading')
      ? 'Uploading…'
      : 'Sending…';
  })();

  const isShown = compose !== undefined && draft !== null;
  // A reply or a forward docks over the rail and the list from `lg`, so the message it answers
  // stays on screen to read, scroll and copy from. Everything else is the centred modal.
  const isWide = useMediaQuery('(min-width: 64rem)');
  const readerLeft = useReaderPaneLeft(isShown && isWide && answersMessage(compose));
  // Held through the closing transition, which runs after the intent has left the URL: the
  // composer leaves in the shape and under the title it had.
  const frameRef = useRef<{ title: string; isWriteStep: boolean; readerLeft: number | null }>({
    title: '',
    isWriteStep: true,
    readerLeft: null,
  });
  if (isShown) {
    frameRef.current = {
      title: step === 'write' ? composeTitleOf(compose, threads, ownedAddresses) : 'Preview',
      isWriteStep: step === 'write',
      readerLeft,
    };
  }
  const frame = frameRef.current;
  // Under either step's footer controls, across the whole grid.
  const sendErrorLine = sendError !== null && (
    <p className="col-span-full text-base text-danger" role="alert">
      {sendError}
    </p>
  );
  const isDocked = frame.readerLeft !== null;

  return (
    <Dialog.Root
      // Open once there is a draft to show, not merely an intent: the intent is there during the
      // resume too. A stray click closes, since closing keeps the draft.
      open={isShown}
      onOpenChange={(open, { reason, cancel }) => {
        if (open) return;
        // Escape steps back out of Preview, as Back does; ✕ and the scrim still close from either.
        if (step === 'preview' && reason === 'escape-key') {
          cancel();
          if (!isSending) showStep('write');
          return;
        }
        close();
      }}
      // Docked, focus stays in the composer while the pointer and the wheel still reach the
      // reader; a click there is reading, not a stray click, so it does not close.
      modal={isDocked ? 'trap-focus' : true}
      disablePointerDismissal={isDocked}
    >
      <Dialog.Portal>
        {!isDocked && (
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/75 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        )}
        <Dialog.Viewport
          className={
            isDocked
              ? 'fixed inset-y-0 left-0 z-50'
              : 'fixed inset-0 z-50 flex items-start justify-center overflow-y-auto sm:p-6 lg:p-10'
          }
          style={frame.readerLeft === null ? undefined : { width: frame.readerLeft }}
        >
          <Dialog.Popup
            data-docked={isDocked ? '' : undefined}
            className={cn(
              'flex w-full flex-col bg-ink-raised outline-none',
              isDocked
                ? 'h-dvh border-r border-rule'
                : 'min-h-dvh sm:h-[min(46rem,calc(100dvh-3rem))] sm:min-h-0 sm:max-w-3xl sm:border sm:border-rule',
              'transition-[opacity,translate] duration-150 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0',
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-1 border-b border-rule-soft pr-1 pl-4">
              <Dialog.Title className="label-rule mr-auto truncate text-paper-dim">
                {frame.title}
              </Dialog.Title>
              {/* Consulted while writing, so it is on the write step's header. */}
              {frame.isWriteStep && <MarkdownCheatSheet />}
              {/* Close keeps the draft. Discard, in the footer, is the only thing that does not. */}
              <Dialog.Close
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    aria-label="Close draft"
                  >
                    <XIcon size={15} />
                  </Button>
                }
              />
            </div>

            {draftError !== null && draftConflict === null && (
              <p
                role="status"
                className="shrink-0 border-b border-rule bg-ink-sunken px-4 py-3 text-base text-paper-dim"
              >
                {draftError}
              </p>
            )}

            {draftConflict !== null && (
              // Both versions exist and nothing has been written; the person picks.
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule bg-ink-sunken px-4 py-3">
                <p role="alert" className="text-base text-paper-dim">
                  Edited on another device.
                </p>
                {/* Not while a Send waits on uploads: their text would go with your files. */}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isSending}
                  onClick={() => resolveDraftConflict('theirs')}
                >
                  Load theirs
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={isSending}
                  onClick={() => resolveDraftConflict('mine')}
                >
                  Keep mine
                </Button>
              </div>
            )}

            {openSendState !== null && (
              // Nothing resends on its own: the message may be at its recipient already.
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule bg-ink-sunken px-4 py-3">
                <p role="alert" className="text-base text-paper-dim">
                  {SEND_STATE_NOTICE[openSendState]}
                </p>
                {openSendState === 'unconfirmed' && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isSending}
                      onClick={() => pressSend(sendAgain)}
                    >
                      Send again
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void backToEditing();
                        // Editing happens on the write step.
                        if (step === 'preview') showStep('write');
                      }}
                    >
                      Back to editing
                    </Button>
                  </>
                )}
                {openSendState === 'accepted' && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isSending}
                      onClick={() => pressSend(sendAgain)}
                    >
                      Save to Sent
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void finishWithoutCopy()}>
                      Finish without copy
                    </Button>
                  </>
                )}
              </div>
            )}

            {draft !== null && step === 'preview' && (
              <DraftPreview ref={previewContent} draft={draft} from={selectedIdentity} />
            )}

            {draft !== null && step === 'write' && (
              <>
                <div className="shrink-0">
                  <FromSwitch
                    value={draft.identityId}
                    onChange={identityId => updateDraft({ identityId })}
                    triggerRef={fromTrigger}
                  />
                  {/* The Cc/Bcc cell is part of the To row, so the row's focus rule runs under it too. */}
                  <div className="group/to flex items-stretch">
                    <FieldLabel htmlFor="compose-to">To</FieldLabel>
                    <Input
                      ref={toInput}
                      id="compose-to"
                      type="email"
                      multiple
                      value={draft.to}
                      onChange={event => updateDraft({ to: event.target.value })}
                      placeholder="name@example.com"
                      autoComplete="off"
                    />
                    {!showCopies && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto shrink-0 border-b border-paper-faint bg-ink-sunken transition-colors group-has-[input:hover]/to:border-paper-dim group-has-[input:focus]/to:border-signal group-has-[input:focus]/to:shadow-[inset_0_-1px_0_var(--signal)]"
                        onClick={() => setShowCopies(true)}
                        aria-label="Show Cc and Bcc"
                      >
                        Cc/Bcc
                      </Button>
                    )}
                  </div>
                  {showCopies && (
                    <>
                      <div className="flex items-stretch">
                        <FieldLabel htmlFor="compose-cc">Cc</FieldLabel>
                        <Input
                          id="compose-cc"
                          type="email"
                          multiple
                          value={draft.cc}
                          onChange={event => updateDraft({ cc: event.target.value })}
                          placeholder="name@example.com"
                          autoComplete="off"
                        />
                      </div>
                      <div className="flex items-stretch">
                        <FieldLabel htmlFor="compose-bcc">Bcc</FieldLabel>
                        <Input
                          id="compose-bcc"
                          type="email"
                          multiple
                          value={draft.bcc}
                          onChange={event => updateDraft({ bcc: event.target.value })}
                          placeholder="name@example.com"
                          autoComplete="off"
                        />
                      </div>
                    </>
                  )}
                  <div className="flex items-stretch">
                    <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
                    <Input
                      id="compose-subject"
                      value={draft.subject}
                      onChange={event => updateDraft({ subject: event.target.value })}
                    />
                  </div>
                </div>

                {/* Sans, at the reading size: plain text is the message, so it is written as it is read. */}
                <textarea
                  ref={bodyInput}
                  value={draft.body}
                  onChange={event => updateDraft({ body: event.target.value })}
                  aria-label="Message body, markdown"
                  className={cn(
                    'min-h-0 w-full flex-1 resize-none bg-ink-raised px-4 py-4 text-[16px]/[1.55] text-paper outline-none lg:text-[15px]/[1.6]',
                    // A docked composer is as wide as the rail and the list together; a line of
                    // mail still wants a measure, as the reader beside it has.
                    isDocked && 'max-w-[80ch]',
                  )}
                />
              </>
            )}

            {draft !== null && (
              <>
                {draft.attachments.length > 0 && (
                  // Keyed on the intent and the session: closing the draft, another draft, a
                  // lock or another account drops any question it asked, bytes and all.
                  <DraftFiles
                    key={seedKey}
                    files={draft.attachments}
                    // The preview shows what goes; a file changes on the write step.
                    isFrozen={step === 'preview' || isSending || isOpenDraftFrozen}
                    loadFile={readStoredFile}
                    onRemove={detach}
                    onRetry={retryUpload}
                    uploadProblem={uploadProblem}
                  />
                )}

                {step === 'write' ? (
                  <div className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 border-t border-rule-soft px-4 py-3">
                    <div className="flex items-center gap-3">
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        className="sr-only"
                        onChange={event => {
                          const files = [...(event.target.files ?? [])];
                          event.target.value = '';
                          // Sizes are known before a byte is read. Same dedupe as `attach`.
                          const kept = draft.attachments.filter(
                            file => !files.some(next => next.name === file.name),
                          );
                          const total = [...kept, ...files].reduce(
                            (sum, file) => sum + file.size,
                            0,
                          );
                          if (total > MAX_ATTACHMENT_BYTES) {
                            setSendError(
                              `Attachments must total under ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
                            );
                            return;
                          }
                          setSendError(null);
                          // A send snapshotted mid-read would go out without the file.
                          setPendingReads(count => count + files.length);
                          // A lock during the read hands this composer to the next session, whose
                          // draft must not gain this person's files.
                          const isCurrent = watchSession();
                          void (async () => {
                            try {
                              const read = await readAttachments(files);
                              if (isCurrent()) attach(read);
                            } catch (err) {
                              if (isCurrent()) {
                                setSendError(err instanceof Error ? err.message : String(err));
                              }
                            } finally {
                              setPendingReads(count => count - files.length);
                            }
                          })();
                        }}
                      />
                      {/*
                        The footer's controls are the one row a thumb uses, so they carry the 44px
                        target on a phone and the compact one from `lg` up — the same shape the
                        header's Close already had, and the reason it was the only control here
                        that met the rule.
                      */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 lg:h-7"
                        disabled={isSending || isOpenDraftFrozen}
                        onClick={() => fileInput.current?.click()}
                      >
                        <PaperclipIcon size={13} />
                        Attach
                      </Button>
                      {/*
                        The one control that destroys writing, so it sits at the opposite end of
                        the bar from Preview and asks before it acts. The record is tombstoned rather
                        than deleted, but no screen in the app brings one back — so from here it
                        is irreversible, and it takes the same sheet Remove address and Reset
                        vault take (DECISIONS.md).
                      */}
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-11 hover:text-danger focus-visible:text-danger lg:h-7"
                            // Frozen as Send is: the bytes may already be on the wire.
                            disabled={isSending || isOpenDraftFrozen}
                          >
                            <TrashIcon size={13} />
                            Discard
                          </Button>
                        }
                        title="Discard this draft?"
                        description={DISCARD_WARNING}
                        confirmLabel="Discard"
                        busyLabel="Discarding…"
                        onConfirm={async () => {
                          const discarded = discardDraft();
                          close();
                          void reportDiscard(discarded);
                        }}
                      />
                    </div>
                    {/* Never disabled: the preview is where a half-written draft says what it lacks. */}
                    <Button
                      ref={previewButton}
                      variant="primary"
                      className="h-11 lg:h-8"
                      onClick={() => showStep('preview')}
                    >
                      <EyeIcon size={13} />
                      Preview
                    </Button>
                    {sendErrorLine}
                  </div>
                ) : (
                  // One grid, so the reason Send is off sits beside Send from `sm` and above the
                  // row below it, in a line whose height is kept: the foot never moves when it goes.
                  <div className="grid shrink-0 grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 border-t border-rule-soft px-4 py-3 sm:grid-cols-[1fr_auto_auto]">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-11 justify-self-start lg:h-7"
                      disabled={isSending}
                      onClick={() => showStep('write')}
                    >
                      <ArrowLeftIcon size={13} />
                      Back to writing
                    </Button>
                    {/* A disabled button shows no tooltip and takes no focus or touch, so the
                        reason is a line of its own. */}
                    <p className="order-first col-span-2 min-h-4 text-2xs text-paper-faint sm:order-none sm:col-span-1 sm:min-h-0 sm:text-right">
                      {missingForSend}
                    </p>
                    <Button
                      variant="primary"
                      className="h-11 lg:h-8"
                      onClick={() => pressSend(send)}
                      disabled={!canSend}
                    >
                      <PaperPlaneRightIcon size={13} weight="fill" />
                      {sendLabel}
                    </Button>
                    {sendErrorLine}
                  </div>
                )}
              </>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
