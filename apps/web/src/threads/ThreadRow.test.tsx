// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../ui/Toast';
import { ColumnsRow } from './ThreadRow';
import type { Folder, ThreadState } from './thread';
import type { MailboxId } from './views';

const mail = vi.hoisted(() => ({
  ownedAddresses: ['me@example.com'],
  toggleArchive: vi.fn(),
  trashThread: vi.fn(),
  restoreThread: vi.fn(),
  removeDraft: vi.fn(),
  toggleStar: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('./use-advance', () => ({ useAdvancePast: () => vi.fn() }));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

const threadIn = (folders: readonly Folder[]): ThreadState => ({
  id: 't1',
  accounts: ['me@example.com'],
  subject: 'Lunch',
  folders,
  foldersByAccount: { 'me@example.com': folders },
  isUnread: false,
  isReplied: false,
  isStarred: false,
  messages: [
    {
      id: 'm1',
      fromName: 'Ada',
      fromAddress: 'ada@example.org',
      toAddress: 'me@example.com',
      at: 1,
      body: [],
    },
  ],
});

const host = document.createElement('div');
const root = createRoot(host);
const showRow = async (mailbox: MailboxId, folders: readonly Folder[]) => {
  await act(async () =>
    root.render(<ColumnsRow thread={threadIn(folders)} mailbox={mailbox} isSelected={false} />),
  );
  return [...host.querySelectorAll('button')].flatMap(button => button.ariaLabel ?? []);
};

afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
  mail.toggleArchive.mockReset();
});

describe('RowTriage', () => {
  it.each([
    ['unified', ['inbox'], ['Archive Lunch', 'Delete Lunch']],
    ['archive', ['archive'], ['Move Lunch to inbox', 'Delete Lunch']],
    // Your own message with no inbox copy: there is nothing to archive.
    ['sent', ['sent'], ['Delete Lunch']],
    ['trash', ['trash'], ['Restore Lunch']],
  ] as const)('in %s, a thread in %j offers %j', async (mailbox, folders, offered) => {
    const labels = await showRow(mailbox, folders);
    expect(labels.filter(label => label !== 'Star Lunch')).toEqual(offered);
  });

  it('says what did not happen, and why, when the store refuses the move', async () => {
    const add = vi.spyOn(toast, 'add');
    mail.toggleArchive.mockImplementation((_threadId, onRefused: (reason: string) => void) => {
      onRefused('imap.example.com: Archive is read-only');
      return false;
    });
    await showRow('unified', ['inbox']);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Archive Lunch"]')?.click(),
    );
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Thread not archived',
        description: 'imap.example.com: Archive is read-only',
      }),
    );
  });
});
