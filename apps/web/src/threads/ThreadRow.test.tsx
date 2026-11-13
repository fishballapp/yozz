// @vitest-environment jsdom

import { type Folder, type ThreadState, VAULT_UID_VALIDITY } from '@yozz.app/mail/threads/thread';
import type { ViewId } from '@yozz.app/mail/threads/views';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '../ui/Toast';
import { addressCellWidth, ThreadRow } from './ThreadRow';

const mail = vi.hoisted(() => ({
  ownedAddresses: ['me@example.com'],
  mailboxes: [{ address: 'me@example.com' }] as { address: string }[],
  toggleArchive: vi.fn(),
  trashThread: vi.fn(),
  restoreThread: vi.fn(),
  moveThreadsWithUndo: vi.fn((threadIds: readonly string[]) => new Set(threadIds)),
  junkFolders: { 'me@example.com': true } as Record<string, boolean>,
  removeDraft: vi.fn(),
  toggleStar: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('./use-advance', () => ({ useAdvancePast: () => vi.fn() }));
vi.mock('../store/MailProvider', () => ({ useMail: () => mail }));

/** A server's copy in each folder, unless `uidValidity` says no server issued them. */
const threadIn = (folders: readonly Folder[], uidValidity = 1): ThreadState => ({
  id: 't1',
  mailboxes: ['me@example.com'],
  subject: 'Lunch',
  folders,
  foldersByMailbox: { 'me@example.com': folders },
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
      locations: folders.map((folder, index) => ({
        mailbox: 'me@example.com',
        folder,
        uidValidity,
        uid: index + 1,
      })),
    },
  ],
});

const host = document.createElement('div');
const root = createRoot(host);
const showRow = async (view: ViewId, folders: readonly Folder[], uidValidity = 1) => {
  await act(async () =>
    root.render(
      <ThreadRow
        thread={threadIn(folders, uidValidity)}
        view={view}
        isSelected={false}
        isChecked={false}
        addressWidth={10}
        hasSelection={false}
        isSelecting={false}
        onCheck={() => {}}
      />,
    ),
  );
  return [...host.querySelectorAll('button')].flatMap(button => button.ariaLabel ?? []);
};

afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
  mail.junkFolders = { 'me@example.com': true };
  mail.toggleArchive.mockReset();
});

describe('RowTriage', () => {
  it.each([
    ['unified', ['inbox'], ['Archive Lunch', 'Move to Junk: Lunch', 'Delete Lunch']],
    ['archive', ['archive'], ['Move Lunch to inbox', 'Move to Junk: Lunch', 'Delete Lunch']],
    // Your own message with no inbox copy: there is nothing to archive, and it is not spam.
    ['sent', ['sent'], ['Delete Lunch']],
    ['trash', ['trash'], ['Restore Lunch']],
    ['junk', ['junk'], ['Move Lunch to inbox', 'Delete Lunch']],
  ] as const)('in %s, a thread in %j offers %j', async (view, folders, offered) => {
    const labels = await showRow(view, folders);
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

describe('a row with no copy on a server', () => {
  it('offers no star, archive or delete while its only copy is the one this tab just sent', async () => {
    // Its Sent copy failed, so this stays until lock: every mark would act on nothing.
    expect(await showRow('sent', ['sent'], VAULT_UID_VALIDITY)).toEqual([]);
  });

  it('offers no Junk where no mailbox holding it has a Junk folder', async () => {
    mail.junkFolders = {};
    expect(await showRow('unified', ['inbox'])).toEqual([
      'Star Lunch',
      'Archive Lunch',
      'Delete Lunch',
    ]);
  });

  it('offers them once the server copy is there', async () => {
    expect(await showRow('sent', ['sent'])).toEqual(['Star Lunch', 'Delete Lunch']);
  });
});

describe('what a row says beside the subject', () => {
  const show = (view: ViewId, thread: ThreadState) =>
    act(async () =>
      root.render(
        <ThreadRow
          thread={thread}
          view={view}
          isSelected={false}
          isChecked={false}
          addressWidth={10}
          hasSelection={false}
          isSelecting={false}
          onCheck={() => {}}
        />,
      ),
    );
  const sent = (): ThreadState => {
    const thread = threadIn(['sent']);
    return {
      ...thread,
      messages: thread.messages.map(message => ({
        ...message,
        fromName: 'Me',
        fromAddress: 'me@example.com',
        toAddress: 'dad@example.org',
        to: [{ name: 'Dad', address: 'dad@example.org' }, { address: 'tom@example.org' }],
      })),
    };
  };

  afterEach(() => {
    mail.mailboxes = [{ address: 'me@example.com' }];
  });

  it('names who it is to in Sent, and who it is from anywhere else', async () => {
    await show('sent', sent());
    expect(host.textContent).toContain('To: Dad, tom@example.org');
    await show('unified', threadIn(['inbox']));
    expect(host.textContent).toContain('Ada');
    expect(host.textContent).not.toContain('To:');
  });

  it('says a draft with no recipient is to no one yet', async () => {
    const thread = threadIn([]);
    await show('drafts', {
      ...thread,
      messages: thread.messages.map(message => ({ ...message, isDraft: true, toAddress: '' })),
    });
    expect(host.textContent).toContain('To: no one yet');
  });

  it('says which address it came to only in a named view with more than one mailbox', async () => {
    await show('unified', threadIn(['inbox']));
    expect(host.textContent).not.toContain('example');

    mail.mailboxes = [{ address: 'me@example.com' }, { address: 'me@work.example' }];
    await show('unified', threadIn(['inbox']));
    expect(host.textContent).toContain('example');
    await show('me@example.com', threadIn(['inbox']));
    expect(host.textContent).not.toContain('example');

    // Two mailboxes at one domain are told apart by their local parts.
    mail.mailboxes = [{ address: 'me@example.com' }, { address: 'sales@example.com' }];
    await show('starred', threadIn(['inbox']));
    expect(host.textContent).toContain('me');
    expect(host.textContent).not.toContain('example');
  });
});

describe('a Drafts row', () => {
  it('discards every draft in its conversation, and says how many first', async () => {
    mail.removeDraft.mockResolvedValue({ outcome: 'deleted' });
    const thread = threadIn([]);
    const [message] = thread.messages;
    if (message === undefined) throw new Error('No message');
    const draft = (draftId: string) => ({ ...message, id: draftId, isDraft: true, draftId });
    await act(async () =>
      root.render(
        <ThreadRow
          thread={{ ...thread, messages: [draft('d-1'), draft('d-2')] }}
          view="drafts"
          isSelected={false}
          isChecked={false}
          addressWidth={10}
          hasSelection={false}
          isSelecting={false}
          onCheck={() => {}}
        />,
      ),
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Discard Lunch"]')?.click(),
    );
    expect(document.body.textContent).toContain('Discard 2 drafts?');
    const confirm = [...document.querySelectorAll('button')].find(
      candidate => candidate.textContent === 'Discard',
    );
    if (confirm === undefined) throw new Error('No confirm');
    await act(async () => confirm.click());
    expect(mail.removeDraft.mock.calls.map(([id]) => id)).toEqual(['d-1', 'd-2']);
  });
});

describe('addressCellWidth', () => {
  const two = [{ address: 'me@example.com' }, { address: 'me@work.example' }];
  const widthOf = (mailboxes: readonly { address: string }[], view: ViewId = 'unified') =>
    addressCellWidth([threadIn(['inbox'])], view, ['me@example.com'], mailboxes);

  it('is as wide as the longest address shown, so the subject keeps the rest', () => {
    // "example", the first label of the domain that tells the two addresses apart.
    expect(widthOf(two)).toBe(7);
  });

  it('stops at 10 characters', () => {
    const long = [{ address: 'me@extraordinarilylong.example' }, { address: 'me@work.example' }];
    const thread = { ...threadIn(['inbox']), mailboxes: ['me@extraordinarilylong.example'] };
    expect(addressCellWidth([thread], 'unified', ['nobody@example.org'], long)).toBe(10);
  });

  it('is nothing where no row shows an address', () => {
    expect(widthOf([{ address: 'me@example.com' }])).toBe(0);
    expect(widthOf(two, 'me@example.com')).toBe(0);
    expect(addressCellWidth([], 'unified', [], two)).toBe(0);
  });
});

describe('a row under the pointer', () => {
  const show = (view: ViewId, props: Partial<Parameters<typeof ThreadRow>[0]> = {}) =>
    act(async () =>
      root.render(
        <ThreadRow
          thread={threadIn(['inbox'])}
          view={view}
          isSelected={false}
          isChecked={false}
          addressWidth={10}
          hasSelection={false}
          isSelecting={false}
          onCheck={() => {}}
          {...props}
        />,
      ),
    );
  /** The cluster, which is the one span laid over the row's edge. */
  const cluster = () => host.querySelector<HTMLElement>('span.absolute.right-2');
  const time = () => host.querySelector<HTMLElement>('span.text-right');

  afterEach(() => {
    mail.mailboxes = [{ address: 'me@example.com' }];
  });

  it('lays the triage over the time instead of opening a column, so no cell moves', async () => {
    await show('unified');
    expect(cluster()?.className).toContain('absolute');
    expect(cluster()?.className).not.toContain('w-0');
    expect(host.firstElementChild?.className).not.toContain('auto_auto_auto]');
    // The time gives up its look, not its room.
    expect(time()?.className).toContain('lg:group-hover:opacity-0');
    expect(time()?.className).not.toContain('hidden');
  });

  it.each([
    ['a plain row', {}, 'bg-ink'],
    ['an unread row', { unread: true }, 'bg-ink-raised'],
    ['a ticked row', { isChecked: true }, 'bg-signal-wash'],
    ['the open row', { isSelected: true }, 'bg-select'],
  ] as const)('gives the cluster %s own ground', async (_state, props, ground) => {
    const { unread, ...rowProps } = props as { unread?: boolean };
    await act(async () =>
      root.render(
        <ThreadRow
          thread={{ ...threadIn(['inbox']), isUnread: unread === true }}
          view="unified"
          isSelected={false}
          isChecked={false}
          addressWidth={10}
          hasSelection={false}
          isSelecting={false}
          onCheck={() => {}}
          {...rowProps}
        />,
      ),
    );
    expect(cluster()?.classList.contains(ground)).toBe(true);
  });

  it('keeps the time’s room beside an address, so the cluster never covers its tag', async () => {
    mail.mailboxes = [{ address: 'me@example.com' }, { address: 'me@work.example' }];
    await show('unified');
    expect(time()?.className).toContain('lg:min-w-21');
  });
});
