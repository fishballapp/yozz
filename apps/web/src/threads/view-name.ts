import { isNamedView, type ViewId } from '@yozz.app/mail/threads/views';
import { JUNK_COPY } from './junk-copy';

/** What each view is called on screen. The unified view's id stays `unified`; its name is Inbox. */
const NAMES = {
  unified: 'Inbox',
  starred: 'Starred',
  drafts: 'Drafts',
  sent: 'Sent',
  archive: 'Archive',
  trash: 'Trash',
  junk: JUNK_COPY.view,
} as const;

/** A named view's name, or an address as written: an address is its own name. */
export const nameOfView = (view: ViewId): string => (isNamedView(view) ? NAMES[view] : view);
