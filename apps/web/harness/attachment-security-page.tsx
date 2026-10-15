/** The browser half of the attachment gate: the real policy module and the real chips, in a page. */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { AttachmentList } from '../src/threads/AttachmentList';
import * as policy from '../src/threads/attachment-preview';
import type { Attachment } from '../src/threads/thread';

export type ProbeFile = {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
};

const element = document.getElementById('root');
if (element === null) throw new Error('attachment harness has no #root');
const root = createRoot(element);

const toAttachment = ({ name, mimeType, base64 }: ProbeFile): Attachment => {
  const content = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  return { name, size: content.byteLength, kind: 'other', mimeType, content };
};

const harness = {
  previewKind: (file: ProbeFile) => policy.previewOf(toAttachment(file))?.kind ?? null,
  mount: (files: readonly ProbeFile[]) =>
    flushSync(() => root.render(<AttachmentList attachments={files.map(toAttachment)} />)),
  unmount: () => flushSync(() => root.render(null)),
};

export type AttachmentHarness = typeof harness;
(globalThis as typeof globalThis & { attachmentSecurity?: AttachmentHarness }).attachmentSecurity =
  harness;
