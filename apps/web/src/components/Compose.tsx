import { Dialog } from '@base-ui/react/dialog';
import { Tabs } from '@base-ui/react/tabs';
import { cn } from '@fishballapps/cn';
import {
  EyeIcon,
  PaperclipIcon,
  PaperPlaneRightIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { agentLabel } from '../lib/agent-label';
import { isDemo } from '../lib/chrome';
import {
  DISCARD_WARNING,
  draftKeyOfIntent,
  seedFor,
  withCompose,
  withoutCompose,
} from '../lib/compose';
import { ATTACHMENT_LABEL, attachmentKindOf, formatBytes } from '../lib/mail-format';
import { MAX_ATTACHMENT_BYTES } from '../mail/send';
import { describeMailFailure, type SendReport, useMail } from '../state/mail';
import { useVault } from '../vault/session';
import { FromSwitch } from './FromSwitch';
import { MarkdownView } from './MarkdownView';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Input } from './ui/Field';
import { toast } from './ui/Toast';

/**
 * Composing is a DOCUMENT, not a chat window.
 *
 * The docked bottom-right panel every webmail ships treats a message as an afterthought you type
 * beside your inbox. YOZZ treats it the way an issue tracker treats an issue: a modal that owns the
 * screen, wide enough to actually write in, and dismissed deliberately rather than by a stray click.
 *
 * Field order inverts Gmail's: From comes FIRST and largest, because in a client whose reason to
 * exist is sending as any address you own, the identity is the decision you make before the
 * recipient.
 *
 * The body is markdown with a Write/Preview pair, the way an issue tracker does it. Rich text is
 * deliberately out of scope for v1.
 *
 * WHETHER it is open is the URL's answer (`?compose=`), and WHAT you have typed is the store's.
 * That split is what makes Back close a draft, a compose link openable in a new tab, and a draft
 * survive switching mailboxes — while keeping a message body, which can be pages long, out of a
 * query string. The store follows the URL and never the other way round: everything that starts a
 * message navigates, and this is the only place that seeds a draft.
 */

const FieldLabel = ({ children, htmlFor }: { children: string; htmlFor?: string }) => (
  <label htmlFor={htmlFor} className="label-rule flex w-20 shrink-0 items-center pl-4">
    {children}
  </label>
);

const TABS = [
  { value: 'write', label: 'Write', Icon: PencilSimpleIcon },
  { value: 'preview', label: 'Preview', Icon: EyeIcon },
] as const;

/**
 * A send outlives the composer that started it, so its result arrives as a toast rather than as a
 * line under a form that has closed. The "Sending…" toast carries no timeout because it is
 * replaced, never expired; the two that report a problem carry none either, because a message
 * that did not go is not news to show for four seconds and take away.
 */
const reportSend = (settled: Promise<SendReport>, reopen: (draftKey: string) => void) => {
  const id = toast.add({ title: 'Sending…', timeout: 0 });
  void settled.then(report => {
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
      // Deliberately not "Sent" and not "Not sent": nobody knows which, and saying either would
      // be the app guessing on the user's behalf about whether a message reached somebody.
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
      // Nothing else on screen knows WHICH draft this was, and Drafts may hold several.
      actionProps: { children: 'Reopen', onClick: () => reopen(report.draftKey) },
    });
  });
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
    threads,
    identities,
    ownedAddresses,
    drafts,
    draftConflict,
    draftError,
    resolveDraftConflict,
    openSendState,
    sendAgain,
    backToEditing,
    discardDraft,
  } = useMail();
  // `to: '.'` — closing a draft leaves you exactly where you were reading, and only drops the
  // param. `replace` because opening and closing a composer is one round trip, not two history
  // entries: without it, Back after closing re-opened a blank draft instead of going back.
  const close = () => {
    void navigate({ to: '.', search: withoutCompose, replace: true });
  };

  /** Puts a refused send back in front of the person: the draft is still in the vault, by key. */
  const reopenDraft = (draftKey: string) => {
    void navigate({ to: '.', search: withCompose(`draft:${draftKey}`), replace: true });
  };

  // The URL → store sync, and the only one in the app. It is guarded by the intent it last acted
  // on rather than by a dependency list, because the store values it reads change on every
  // keystroke — a plain dependency list would re-seed the draft out from under you as you type.
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingReads, setPendingReads] = useState(0);
  // Cc and Bcc are folded away until asked for: most mail has neither, and two more empty wells
  // above the subject is two more things to read past on every message that does not. A reply-all
  // arrives with a Cc already in it, so it opens with them out.
  const [showCopies, setShowCopies] = useState(false);
  // This component sits in the root route, above the vault gate, so it is on screen while the
  // session is still resuming. Seeding then would be undone by the lock branch of the provider,
  // and the intent alone would never seed again: the seed is keyed on the session as well, and
  // waits for one.
  const { session } = useVault();
  const canSeed = isDemo() || session !== null;
  const seedKey = `${compose ?? ''}\0${session?.userId ?? ''}`;
  const seeded = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (seeded.current === seedKey || !canSeed) return;
    const seed = compose === undefined ? {} : seedFor(compose, threads, identities, ownedAddresses);
    // A reply or forward names a MESSAGE. Until the mail it names has loaded `seedFor` has
    // nothing, and seeding then would fix an empty draft for good — so a referenced intent is not
    // marked seeded until it resolves; the effect simply runs again as mail arrives.
    //
    // A `draft:` intent is not one of those: its content comes from the vault record rather than
    // from a message, so `seedFor` returns nothing for it BY DESIGN and waiting for a seed here
    // would leave every draft URL stuck open-but-empty for ever.
    const draftKey = compose === undefined ? null : draftKeyOfIntent(compose);
    const namesMessage = compose !== undefined && compose !== 'new' && draftKey === null;
    if (namesMessage && Object.keys(seed).length === 0) return;
    // The same wait, for the same reason, one step later: a `draft:` intent resolves against the
    // vault records, which load after unlock. Seeding before they arrive would mark the intent
    // done and leave the composer empty even once the record is here.
    if (draftKey !== null && !drafts.some(candidate => candidate.draftKey === draftKey)) return;
    seeded.current = seedKey;
    setSendError(null);
    const opened = seedDraft(compose, seed);
    setShowCopies(opened !== null && (opened.cc !== '' || opened.bcc !== ''));
  }, [compose, seedKey, canSeed, seedDraft, threads, identities, ownedAddresses, drafts]);

  const fileInput = useRef<HTMLInputElement>(null);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const toInput = useRef<HTMLInputElement>(null);

  // A reply opens with the quoted original already in the body, and you write ABOVE a quote — so
  // the caret starts at position 0, not after the quote. A blank draft has nothing to write above,
  // so it starts in the recipient field instead. Keyed on open/close only, never on keystrokes.
  const isOpen = draft !== null;
  // A reply has both a quote AND a recipient. A forward has a quote but no recipient yet, so
  // the thing to fill first is To, not the body.
  const startedAsReply = (draft?.startedAsReply ?? false) && (draft?.to ?? '') !== '';
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      if (startedAsReply) {
        bodyInput.current?.focus();
        bodyInput.current?.setSelectionRange(0, 0);
        return;
      }
      toInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // Both deps are fixed for the life of a draft, so this never fires on a keystroke.
  }, [isOpen, startedAsReply]);

  return (
    <Dialog.Root
      // Open once there is a draft to show, not merely an intent in the URL: the intent is there
      // during the resume too, and a dialog with no fields in it is what that looked like.
      //
      // Clicking past it closes it, like the X and like Escape. It carried `disablePointerDismissal`
      // for as long as closing meant DISCARDING — a draft must not vanish because you clicked
      // beside it — and that reason went when Discard became its own button. Closing keeps the
      // draft now, so the stray click is free.
      open={compose !== undefined && draft !== null}
      onOpenChange={open => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/75 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto sm:p-6 lg:p-10">
          <Dialog.Popup
            className={cn(
              'flex min-h-dvh w-full flex-col bg-ink-raised outline-none',
              'sm:h-[min(46rem,calc(100dvh-3rem))] sm:min-h-0 sm:max-w-3xl sm:border sm:border-rule',
              'transition-[opacity,translate] duration-150 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0',
            )}
          >
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-rule-soft pr-1 pl-4">
              <Dialog.Title className="label-rule text-paper-dim">New message</Dialog.Title>
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
              /**
               * Both versions still exist and nothing has been written: the person picks. No
               * merge, and no "newest wins" — either would silently throw away prose somebody
               * typed, which is the one outcome a draft store must never produce.
               */
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule bg-ink-sunken px-4 py-3">
                <p role="alert" className="text-base text-paper-dim">
                  Edited on another device.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => resolveDraftConflict('theirs')}
                >
                  Load theirs
                </Button>
                <Button variant="ghost" size="sm" onClick={() => resolveDraftConflict('mine')}>
                  Keep mine
                </Button>
              </div>
            )}

            {openSendState !== null && (
              /**
               * A send that never reported back. Nothing here resends on its own: the message may
               * be at its recipient already, and only the person can decide that a second copy is
               * better than a lost one.
               */
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-rule bg-ink-sunken px-4 py-3">
                <p role="alert" className="text-base text-paper-dim">
                  {openSendState === 'sending'
                    ? 'Sending — this draft is frozen until it finishes.'
                    : 'This may already have been sent.'}
                </p>
                {openSendState === 'unconfirmed' && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => void sendAgain()}>
                      Send again
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void backToEditing()}>
                      Back to editing
                    </Button>
                  </>
                )}
              </div>
            )}

            {draft !== null && (
              <>
                <div className="shrink-0">
                  <FromSwitch
                    value={draft.identityId}
                    onChange={identityId => updateDraft({ identityId })}
                  />
                  <div className="flex items-stretch">
                    <FieldLabel htmlFor="compose-to">To</FieldLabel>
                    <Input
                      ref={toInput}
                      id="compose-to"
                      aria-label={agentLabel('To', draft.to)}
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
                        className="h-auto shrink-0 border-b border-rule bg-ink-sunken"
                        onClick={() => setShowCopies(true)}
                        aria-label="Show Cc and Bcc"
                      >
                        Cc Bcc
                      </Button>
                    )}
                  </div>
                  {showCopies && (
                    <>
                      <div className="flex items-stretch">
                        <FieldLabel htmlFor="compose-cc">Cc</FieldLabel>
                        <Input
                          id="compose-cc"
                          aria-label={agentLabel('Cc', draft.cc)}
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
                          aria-label={agentLabel('Bcc', draft.bcc)}
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
                      placeholder="No subject"
                    />
                  </div>
                </div>

                <Tabs.Root defaultValue="write" className="flex min-h-0 flex-1 flex-col">
                  <Tabs.List className="flex shrink-0 items-center gap-4 border-b border-rule-soft px-4">
                    {TABS.map(({ value, label, Icon }) => (
                      <Tabs.Tab
                        key={value}
                        value={value}
                        className="label-rule -mb-px flex items-center gap-1.5 border-b-2 border-transparent py-2.5 outline-none transition-colors hover:text-paper data-active:border-signal data-active:text-paper"
                      >
                        <Icon size={13} />
                        {label}
                      </Tabs.Tab>
                    ))}
                    <span className="ml-auto font-mono text-2xs text-paper-faint">markdown</span>
                  </Tabs.List>

                  <Tabs.Panel value="write" className="min-h-0 flex-1 outline-none">
                    <textarea
                      ref={bodyInput}
                      value={draft.body}
                      onChange={event => updateDraft({ body: event.target.value })}
                      placeholder={
                        'Write your message.\n\nMarkdown works — **bold**, lists, > quotes.'
                      }
                      aria-label="Message body, markdown"
                      className="h-full w-full resize-none bg-ink-raised px-4 py-4 font-mono text-[13px] leading-[1.7] text-paper outline-none placeholder:text-paper-faint"
                    />
                  </Tabs.Panel>

                  <Tabs.Panel
                    value="preview"
                    className="min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none"
                  >
                    {draft.body.trim() === '' ? (
                      <p className="text-base text-paper-faint">Nothing to preview yet.</p>
                    ) : (
                      <MarkdownView source={draft.body} />
                    )}
                  </Tabs.Panel>
                </Tabs.Root>

                {draft.attachments.length > 0 && (
                  <ul className="flex shrink-0 flex-wrap gap-2 border-t border-rule-soft px-4 py-2.5">
                    {draft.attachments.map(file => (
                      <li
                        key={file.name}
                        className="flex items-center gap-2 bg-ink px-2 py-1 font-mono text-2xs text-paper-dim"
                      >
                        <span className="text-paper-faint">{ATTACHMENT_LABEL[file.kind]}</span>
                        <span className="max-w-56 truncate text-paper">{file.name}</span>
                        <span className="text-paper-faint">{formatBytes(file.size)}</span>
                        <button
                          type="button"
                          onClick={() => detach(file.name)}
                          className="-m-1 flex size-6 items-center justify-center -outline-offset-2 text-paper-faint hover:text-paper"
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex shrink-0 flex-col gap-2 border-t border-rule-soft px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        className="sr-only"
                        onChange={event => {
                          const files = [...(event.target.files ?? [])];
                          event.target.value = '';
                          // Sizes are known before a byte is read: the refusal costs nothing and
                          // an accidental multi-gigabyte pick never reaches memory. Same dedupe as
                          // `attach`: a re-picked filename replaces, not adds.
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
                          // Send waits for the bytes: a send snapshotted mid-read would go out
                          // without the file and still report success.
                          setPendingReads(count => count + files.length);
                          void (async () => {
                            try {
                              attach(
                                await Promise.all(
                                  files.map(async file => ({
                                    name: file.name,
                                    size: file.size,
                                    kind: attachmentKindOf(file.type),
                                    mimeType: file.type === '' ? undefined : file.type,
                                    content: new Uint8Array(await file.arrayBuffer()),
                                  })),
                                ),
                              );
                            } catch (err) {
                              setSendError(err instanceof Error ? err.message : String(err));
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
                        onClick={() => fileInput.current?.click()}
                      >
                        <PaperclipIcon size={13} />
                        Attach
                      </Button>
                      {/*
                        The one control that destroys writing, so it sits at the opposite end of
                        the bar from Send and asks before it acts. The record is tombstoned rather
                        than deleted, but no screen in the app brings one back — so from here it
                        is irreversible, and it takes the same sheet Remove address and Reset
                        vault take (DECISIONS.md).
                      */}
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="danger"
                            size="sm"
                            className="h-11 lg:h-7"
                            // Frozen as Send is: the bytes may already be on the wire.
                            disabled={isSending || openSendState === 'sending'}
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
                          await discardDraft();
                          close();
                        }}
                      />
                    </div>
                    <Button
                      variant="primary"
                      className="h-11 lg:h-8"
                      onClick={() => {
                        void (async () => {
                          setIsSending(true);
                          setSendError(null);
                          try {
                            const claimed = await send();
                            if (!claimed.ok) {
                              const host =
                                identities.find(identity => identity.address === draft.identityId)
                                  ?.smtp.host ?? draft.identityId;
                              setSendError(describeMailFailure(claimed.error, host));
                              return;
                            }
                            // The bytes are frozen; the rest of the send outlives this dialog.
                            close();
                            reportSend(claimed.value.settled, reopenDraft);
                          } catch (err) {
                            setSendError(err instanceof Error ? err.message : String(err));
                          } finally {
                            setIsSending(false);
                          }
                        })();
                      }}
                      // A Bcc-only send is a real message — any one of the three fields is enough.
                      disabled={
                        isSending ||
                        // Frozen by a send in flight, here or on another device.
                        openSendState === 'sending' ||
                        pendingReads > 0 ||
                        [draft.to, draft.cc, draft.bcc].every(field => field.trim() === '')
                      }
                    >
                      <PaperPlaneRightIcon size={13} weight="fill" />
                      {isSending ? 'Sending…' : 'Send'}
                    </Button>
                  </div>
                  {sendError !== null && (
                    <p className="text-2xs text-signal" role="alert">
                      {sendError}
                    </p>
                  )}
                </div>
              </>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
