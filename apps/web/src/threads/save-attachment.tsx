import { attachmentFactsOf, noteText, savedName } from '@yozz.app/mail/threads/attachment-content';
import type { Attachment } from '@yozz.app/mail/threads/thread';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { download } from './attachment-preview';

/** Every string the attachment notes add, so a copy pass rewrites them in one place. */
const COPY = {
  confirmTitle: (name: string) => `Download ${name}?`,
  confirm: 'Download',
  busy: 'Downloading…',
};

type Held = Attachment & { readonly content: Uint8Array<ArrayBuffer> };

/**
 * Whether the component is still mounted, for an `await` that resolves after its control is gone:
 * a chip whose file was removed, a draft closed or a vault locked mid-fetch saves nothing.
 */
export const useIsMounted = () => {
  const isMounted = useRef(false);
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);
  return () => isMounted.current;
};

/**
 * Saves an attachment whose bytes are in hand, first asking when they carry notes. The notes are
 * read from those very bytes and the saved name, so a file fetched from R2 or forwarded into a
 * draft is judged on what is written, not on what its chip knew before the fetch. The question
 * belongs to the component that calls this and dies with it, bytes and all, so mount it no wider
 * than the surface that asks (one message's list, one draft's files). A question already open is
 * never replaced: a second fetch that lands meanwhile is dropped, and its chip can be clicked again.
 * Render `dialog` once inside the surface: in a dialog, inside its popup, so Escape closes only it.
 */
export const useSaveAttachment = (): { save: (file: Held) => void; dialog: ReactNode } => {
  const [asked, setAsked] = useState<{ file: Held; notes: readonly string[] } | null>(null);
  const save = (file: Held) => {
    const notes = attachmentFactsOf(file).notes.map(noteText);
    if (notes.length === 0) {
      download(file);
      return;
    }
    setAsked(current => current ?? { file, notes });
  };
  const dialog =
    asked === null ? null : (
      <ConfirmDialog
        open
        onOpenChange={isOpen => {
          if (!isOpen) setAsked(null);
        }}
        title={COPY.confirmTitle(savedName(asked.file.name))}
        description={asked.notes.join(' ')}
        confirmLabel={COPY.confirm}
        confirmVariant="primary"
        busyLabel={COPY.busy}
        onConfirm={async () => download(asked.file)}
      />
    );
  return { save, dialog };
};
