import { Button as BaseButton } from '@base-ui/react/button';
import { Dialog } from '@base-ui/react/dialog';
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  attachmentFactsOf,
  type DetectedType,
  decodeText,
  noteText,
  type Preview,
  previewOf,
  savedName,
} from '@yozz.app/mail/threads/attachment-content';
import type { Attachment } from '@yozz.app/mail/threads/thread';
import { cn } from 'cn';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button, buttonClass } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';
import { objectUrlFor } from './attachment-preview';
import { attachmentTag, formatBytes } from './attachments';
import { useIsMounted, useSaveAttachment } from './save-attachment';

type PdfPreview = Extract<Preview, { kind: 'pdf' }>;

/** What the list knows of one attachment before anything is clicked. */
type FileFacts = {
  readonly preview: Preview | null;
  readonly detectedType: DetectedType | null;
  /** Each note's sentence, as every client words it. */
  readonly notes: readonly string[];
};

const factsOf = (file: Attachment): FileFacts => {
  const { detectedType, notes } = attachmentFactsOf(file);
  return { preview: previewOf(file), detectedType, notes: notes.map(noteText) };
};

/** Saves bytes in hand, asking first when they carry notes (`useSaveAttachment`). */
type SaveAttachment = ReturnType<typeof useSaveAttachment>['save'];

/**
 * One URL per PDF for as long as its message is on screen, revoked when the message goes. The new
 * tab resolves it on its own schedule, and a reload there should still find the file.
 */
const usePdfOpener = () => {
  const urls = useRef(new Map<Uint8Array, string>());
  useEffect(() => {
    const opened = urls.current;
    return () => {
      for (const url of opened.values()) URL.revokeObjectURL(url);
      opened.clear();
    };
  }, []);
  return (content: Uint8Array<ArrayBuffer>, preview: PdfPreview) => {
    const url = urls.current.get(content) ?? objectUrlFor(content, preview);
    urls.current.set(content, url);
    // The browser's own viewer, in a tab of its own; `noopener` leaves it no handle on this one.
    window.open(url, '_blank', 'noopener');
  };
};

/** Tag, name and size: the facts every chip and the viewer's title bar share. */
const Facts = ({ file, facts }: { file: Attachment; facts: FileFacts }) => (
  <>
    <span className="shrink-0 text-paper-faint">
      {attachmentTag(file.kind, facts.detectedType, facts.preview)}
    </span>
    <span dir="auto" className="min-w-0 max-w-64 truncate text-paper">
      {savedName(file.name)}
    </span>
    <span className="shrink-0 text-paper-faint">{formatBytes(file.size)}</span>
  </>
);

/** A file's notes, under its chip. */
const Notes = ({ id, notes }: { id: string; notes: readonly string[] }) => (
  <div id={id} className="mt-1 flex flex-col gap-0.5 text-2xs text-paper-dim">
    {notes.map(note => (
      <p key={note} className="flex items-start gap-1.5">
        <WarningIcon size={11} className="mt-0.5 shrink-0 text-danger" aria-hidden />
        {note}
      </p>
    ))}
  </div>
);

/** Reads a file kept in R2, for a chip whose bytes are not on this device. */
export type LoadStoredFile = (fileId: string) => Promise<Uint8Array<ArrayBuffer> | null>;

/** A chip whose bytes are in R2: fetched when it is clicked, and saying so if that fails. */
const StoredFileChip = ({
  file,
  fileId,
  facts,
  notesId,
  loadFile,
  onSave,
}: {
  file: Attachment;
  fileId: string;
  /** From the name and the declared type alone, until a click fetches the bytes. */
  facts: FileFacts;
  notesId: string | undefined;
  loadFile: LoadStoredFile;
  onSave: SaveAttachment;
}) => {
  const [state, setState] = useState<'idle' | 'downloading' | 'failed'>('idle');
  const isMounted = useIsMounted();
  const name = savedName(file.name);
  return (
    <button
      type="button"
      disabled={state === 'downloading'}
      aria-describedby={notesId}
      onClick={async () => {
        setState('downloading');
        try {
          const content = await loadFile(fileId);
          if (!isMounted()) return;
          if (content === null) throw new Error(`${fileId} is gone`);
          setState('idle');
          // Judged on the fetched bytes: a forwarded file's name may not tell what they are.
          onSave({ ...file, content });
        } catch {
          setState('failed');
        }
      }}
      className="flex h-11 max-w-full items-center gap-2.5 border border-rule bg-ink px-2.5 text-left font-mono text-2xs transition-colors hover:bg-ink-hover disabled:cursor-default disabled:hover:bg-ink lg:h-7"
      aria-label={`Download ${name}, ${formatBytes(file.size)}`}
    >
      <Facts file={file} facts={facts} />
      {state === 'downloading' && <span className="shrink-0 text-paper-faint">Downloading…</span>}
      {state === 'failed' && <span className="shrink-0 text-danger">Couldn’t download</span>}
      <DownloadSimpleIcon size={12} className="shrink-0 text-paper-faint" />
    </button>
  );
};

/**
 * A chip that previews is two cells ruled as one box: the facts open it, the glyph downloads. One
 * that does not is a single download, as every attachment was before previews.
 */
const AttachmentChip = ({
  file,
  facts,
  notesId,
  onOpen,
  onDownload,
}: {
  file: Attachment;
  facts: FileFacts;
  notesId: string | undefined;
  onOpen: () => void;
  onDownload: () => void;
}) => {
  const name = savedName(file.name);
  const { preview } = facts;
  if (preview === null) {
    return (
      <button
        type="button"
        onClick={onDownload}
        disabled={file.content === undefined}
        aria-describedby={notesId}
        className="flex h-11 max-w-full items-center gap-2.5 border border-rule bg-ink px-2.5 text-left font-mono text-2xs transition-colors hover:bg-ink-hover disabled:cursor-default disabled:hover:bg-ink lg:h-7"
        aria-label={`Download ${name}, ${formatBytes(file.size)}`}
      >
        <Facts file={file} facts={facts} />
        <DownloadSimpleIcon size={12} className="shrink-0 text-paper-faint" />
      </button>
    );
  }
  return (
    <div className="flex h-11 max-w-full divide-x divide-rule border border-rule bg-ink font-mono text-2xs lg:h-7">
      <button
        type="button"
        onClick={onOpen}
        aria-describedby={notesId}
        className="flex min-w-0 items-center gap-2.5 px-2.5 text-left -outline-offset-2 transition-colors hover:bg-ink-hover"
        aria-label={
          preview.kind === 'pdf'
            ? `Open ${name} in a new tab, ${formatBytes(file.size)}`
            : `Preview ${name}, ${formatBytes(file.size)}`
        }
      >
        <Facts file={file} facts={facts} />
        {/* It leaves the app, so it says so. */}
        {preview.kind === 'pdf' && (
          <ArrowSquareOutIcon size={12} className="shrink-0 text-paper-faint" />
        )}
      </button>
      <Tooltip label={`Download ${name}`}>
        <button
          type="button"
          onClick={onDownload}
          aria-describedby={notesId}
          className="flex w-11 shrink-0 items-center justify-center text-paper-faint -outline-offset-2 transition-colors hover:bg-ink-hover hover:text-paper lg:w-7"
          aria-label={`Download ${name}`}
        >
          <DownloadSimpleIcon size={12} />
        </button>
      </Tooltip>
    </div>
  );
};

/** The URL lives exactly as long as the image is on the stage: stepping away or closing revokes it. */
const ImageStage = ({
  content,
  preview,
  name,
}: {
  content: Uint8Array<ArrayBuffer>;
  preview: Extract<Preview, { kind: 'image' }>;
  name: string;
}) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const created = objectUrlFor(content, preview);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [content, preview]);
  return (
    <div className="flex h-full items-center justify-center p-4 sm:p-6">
      {url !== null && (
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
      )}
    </div>
  );
};

/** A React text node, so markup in the file is shown, never parsed. */
const TextStage = ({ content }: { content: Uint8Array }) => {
  const text = useMemo(() => decodeText(content), [content]);
  return (
    <pre
      dir="auto"
      className="h-full overflow-auto px-5 py-4 font-mono text-[13px] leading-[1.7] whitespace-pre-wrap text-paper -outline-offset-2 [overflow-wrap:anywhere]"
    >
      {text}
    </pre>
  );
};

/** What the stage says for a file it does not draw: a PDF opens elsewhere, anything else downloads. */
const Notice = ({
  children,
  action,
}: {
  children: string;
  action: {
    label: string;
    Icon: typeof DownloadSimpleIcon;
    onClick: () => void;
    isDisabled?: boolean;
  };
}) => (
  <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
    <p className="max-w-sm text-base text-paper-dim">{children}</p>
    <Button variant="secondary" onClick={action.onClick} disabled={action.isDisabled}>
      <action.Icon size={13} />
      {action.label}
    </Button>
  </div>
);

/**
 * At the end of the run it is `aria-disabled`, not disabled: a natively disabled button drops focus,
 * and Firefox hands it to `body`, outside the dialog and out of reach of its arrow keys.
 */
const StepButton = ({
  label,
  isAtEnd,
  onStep,
  children,
}: {
  label: string;
  isAtEnd: boolean;
  onStep: () => void;
  children: ReactNode;
}) => (
  <Tooltip label={label}>
    <BaseButton
      focusableWhenDisabled
      disabled={isAtEnd}
      onClick={onStep}
      aria-label={label}
      className={cn(
        buttonClass({ variant: 'ghost', size: 'icon' }),
        'size-11 data-disabled:pointer-events-none data-disabled:bg-transparent data-disabled:text-paper-faint lg:size-7',
      )}
    >
      {children}
    </BaseButton>
  </Tooltip>
);

const AttachmentViewer = ({
  attachments,
  facts,
  index,
  isOpen,
  onIndexChange,
  onClose,
  onClosed,
  onOpenPdf,
  onDownload,
  children,
}: {
  attachments: readonly Attachment[];
  facts: readonly FileFacts[];
  /** Held through the closing transition, so the stage does not empty while it fades. */
  index: number | null;
  isOpen: boolean;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  onClosed: () => void;
  onOpenPdf: (content: Uint8Array<ArrayBuffer>, preview: PdfPreview) => void;
  onDownload: (index: number) => void;
  /** The download question, rendered inside the popup so it nests: Escape closes only it. */
  children: ReactNode;
}) => {
  const file = index === null ? undefined : attachments[index];
  const fileFacts = index === null ? undefined : facts[index];
  const preview = fileFacts?.preview ?? null;
  const step = (by: -1 | 1) => {
    if (index === null) return;
    const next = index + by;
    if (next >= 0 && next < attachments.length) onIndexChange(next);
  };

  const stage = (() => {
    if (file === undefined) return null;
    const { content } = file;
    // `previewOf` answers null without bytes; the check is for the type system.
    if (content === undefined || preview === null) {
      return (
        <Notice
          action={{
            label: 'Download',
            Icon: DownloadSimpleIcon,
            onClick: () => {
              if (index !== null) onDownload(index);
            },
            isDisabled: content === undefined,
          }}
        >
          YOZZ previews images, plain text and PDFs. Download this file to open it.
        </Notice>
      );
    }
    switch (preview.kind) {
      case 'image':
        return (
          <ImageStage key={index} content={content} preview={preview} name={savedName(file.name)} />
        );
      case 'text':
        return <TextStage key={index} content={content} />;
      case 'pdf':
        return (
          <Notice
            action={{
              label: 'Open in a new tab',
              Icon: ArrowSquareOutIcon,
              onClick: () => onOpenPdf(content, preview),
            }}
          >
            A PDF opens in your browser's own viewer, in a new tab.
          </Notice>
        );
    }
  })();

  return (
    <Dialog.Root
      open={isOpen}
      onOpenChange={open => {
        if (!open) onClose();
      }}
      onOpenChangeComplete={open => {
        if (!open) onClosed();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-ink/75 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 z-50 flex sm:p-6 lg:p-10">
          <Dialog.Popup
            onKeyDown={event => {
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              if (event.key === 'ArrowLeft') step(-1);
              if (event.key === 'ArrowRight') step(1);
            }}
            className={cn(
              'flex h-dvh w-full flex-col bg-ink-raised outline-none sm:h-full sm:border sm:border-rule',
              'transition-[opacity,translate] duration-150 data-ending-style:translate-y-1 data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0',
            )}
          >
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-rule-soft pr-1 pl-4">
              <div className="flex min-w-0 flex-1 items-baseline gap-2.5 font-mono text-2xs">
                {file !== undefined && fileFacts !== undefined && (
                  <>
                    <span className="hidden text-paper-faint sm:inline">
                      {attachmentTag(file.kind, fileFacts.detectedType, preview)}
                    </span>
                    <Dialog.Title
                      dir="auto"
                      className="min-w-0 truncate font-sans text-base text-paper"
                    >
                      {savedName(file.name)}
                    </Dialog.Title>
                    <span className="hidden shrink-0 text-paper-faint sm:inline">
                      {formatBytes(file.size)}
                    </span>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center">
                {attachments.length > 1 && index !== null && (
                  <>
                    <StepButton
                      label="Previous attachment"
                      isAtEnd={index === 0}
                      onStep={() => step(-1)}
                    >
                      <CaretLeftIcon size={15} />
                    </StepButton>
                    <span className="px-1 font-mono text-2xs text-paper-faint" aria-live="polite">
                      <span className="sr-only">Attachment </span>
                      {index + 1}
                      <span aria-hidden> / </span>
                      <span className="sr-only"> of </span>
                      {attachments.length}
                    </span>
                    <StepButton
                      label="Next attachment"
                      isAtEnd={index === attachments.length - 1}
                      onStep={() => step(1)}
                    >
                      <CaretRightIcon size={15} />
                    </StepButton>
                    <span aria-hidden className="mx-1.5 h-5 w-px bg-rule" />
                  </>
                )}
                {file !== undefined && index !== null && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 lg:size-7"
                    onClick={() => onDownload(index)}
                    disabled={file.content === undefined}
                    aria-label={`Download ${savedName(file.name)}`}
                  >
                    <DownloadSimpleIcon size={15} />
                  </Button>
                )}
                <Dialog.Close
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 lg:size-7"
                      aria-label="Close preview"
                    >
                      <XIcon size={15} />
                    </Button>
                  }
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 bg-ink-sunken">{stage}</div>
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

/**
 * A message's attachments as chips. An image or a text file opens in the viewer, which steps
 * through every attachment of the message; a PDF opens in the browser's viewer in a new tab; the
 * rest download. Download stays one click away on every one of them.
 */
export const AttachmentList = ({
  attachments,
  loadFile,
}: {
  attachments: readonly Attachment[];
  loadFile?: LoadStoredFile | undefined;
}) => {
  const entries = useMemo(
    () => attachments.map(file => ({ file, facts: factsOf(file) })),
    [attachments],
  );
  const openPdf = usePdfOpener();
  const [viewed, setViewed] = useState<number | null>(null);
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const notesIdPrefix = useId();
  const { save, dialog } = useSaveAttachment();
  const saveAt = (index: number) => {
    const file = attachments[index];
    if (file?.content === undefined) return;
    save({ ...file, content: file.content });
  };

  return (
    <>
      <ul className="mt-4 flex flex-wrap gap-2">
        {entries.map(({ file, facts: fileFacts }, index) => {
          const { preview } = fileFacts;
          const notesId =
            fileFacts.notes.length === 0 ? undefined : `${notesIdPrefix}-notes-${index}`;
          return (
            // Two parts of one message can share a name.
            <li key={`${index}-${file.name}`} className="max-w-full">
              {file.fileId !== undefined && loadFile !== undefined ? (
                <StoredFileChip
                  file={file}
                  fileId={file.fileId}
                  facts={fileFacts}
                  notesId={notesId}
                  loadFile={loadFile}
                  onSave={save}
                />
              ) : (
                <AttachmentChip
                  file={file}
                  facts={fileFacts}
                  notesId={notesId}
                  onDownload={() => saveAt(index)}
                  onOpen={() => {
                    if (preview?.kind === 'pdf' && file.content !== undefined) {
                      openPdf(file.content, preview);
                      return;
                    }
                    setViewed(index);
                    setIsViewerOpen(true);
                  }}
                />
              )}
              {notesId !== undefined && <Notes id={notesId} notes={fileFacts.notes} />}
            </li>
          );
        })}
      </ul>
      <AttachmentViewer
        attachments={attachments}
        facts={entries.map(({ facts }) => facts)}
        index={viewed}
        isOpen={isViewerOpen}
        onIndexChange={setViewed}
        onClose={() => setIsViewerOpen(false)}
        onClosed={() => setViewed(null)}
        onOpenPdf={openPdf}
        onDownload={saveAt}
      >
        {isViewerOpen && dialog}
      </AttachmentViewer>
      {!isViewerOpen && dialog}
    </>
  );
};
