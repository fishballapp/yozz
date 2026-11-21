// @vitest-environment jsdom

import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { Attachment } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composer } from '../store/use-composer';
import { toast } from '../ui/Toast';
import { Compose } from './Compose';
import type { SendReport } from './draft';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type SendAnswer = Awaited<ReturnType<Composer['send']>>;

const DRAFT: ComposeDraft = {
  startedAsReply: false,
  identityId: 'me@x.test',
  to: 'you@x.test',
  cc: '',
  bcc: '',
  subject: 'Plans',
  body: 'Hello',
  attachments: [],
};

const ME: AddressRecord = {
  address: 'me@x.test',
  senderName: 'Me Myself',
  smtp: { host: 'smtp.x.test', port: 465, username: 'me', password: 'pw' },
  imap: { host: 'imap.x.test', port: 993, username: 'me', password: 'pw' },
};

const RELAY: AddressRecord = {
  address: 'news@relay.test',
  smtp: { host: 'smtp.relay.test', port: 587, username: 'news', password: 'pw' },
};

/** The store as the composer sees it; `generation` is what a lock or a sign-in moves on. */
const mail = vi.hoisted(() => ({
  generation: 0,
  identities: [] as AddressRecord[],
  send: vi.fn(),
  attach: vi.fn(),
  retryUpload: vi.fn(),
  detach: vi.fn(),
  draft: null as ComposeDraft | null,
  draftConflict: null as unknown,
  openSendState: null as Composer['openSendState'],
  isOpenSendOver: false,
  sendAgain: vi.fn(),
  backToEditing: vi.fn(),
  finishWithoutCopy: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());
const reading = vi.hoisted(() => ({ files: null as PromiseWithResolvers<Attachment[]> | null }));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ compose: 'new' }),
  useNavigate: () => navigate,
  useLocation: () => '/m/unified',
}));
vi.mock('../vault/session', () => ({ useVault: () => ({ session: { userId: 'user-1' } }) }));
vi.mock('./draft', async importOriginal => ({
  ...(await importOriginal<typeof import('./draft')>()),
  readAttachments: () => reading.files?.promise,
}));
vi.mock('../store/MailProvider', () => ({
  useComposer: () => ({
    draft: mail.draft ?? DRAFT,
    seedDraft: () => mail.draft ?? DRAFT,
    updateDraft: vi.fn(),
    send: mail.send,
    attach: mail.attach,
    detach: mail.detach,
    retryUpload: mail.retryUpload,
    draftConflict: mail.draftConflict,
    draftError: null,
    resolveDraftConflict: vi.fn(),
    openSendState: mail.openSendState,
    isOpenDraftFrozen: mail.openSendState !== null,
    isOpenSendOver: mail.isOpenSendOver,
    sendAgain: mail.sendAgain,
    backToEditing: mail.backToEditing,
    finishWithoutCopy: mail.finishWithoutCopy,
    discardDraft: vi.fn(),
  }),
  useMail: () => ({
    threads: [],
    identities: mail.identities,
    ownedAddresses: [],
    drafts: [],
    readStoredFile: async () => null,
    watchSession: () => {
      const taken = mail.generation;
      return () => mail.generation === taken;
    },
  }),
}));

const root = createRoot(document.createElement('div'));

const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find(({ textContent }) => textContent === label);

const press = async (label: string) => {
  const button = buttonNamed(label);
  if (button === undefined) throw new Error(`no ${label} button`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    button.click();
  });
};

// The From select's trigger is the combobox of the dialog.
const isFromFocused = () => document.activeElement?.getAttribute('role') === 'combobox';

const nextFrame = () =>
  act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent);

beforeEach(async () => {
  mail.generation = 0;
  mail.identities = [ME, RELAY];
  // jsdom has no matchMedia; a phone-width window, where the composer is never docked.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  await act(async () => root.render(<Compose />));
});

afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
  mail.send.mockReset();
  mail.attach.mockReset();
  mail.openSendState = null;
  mail.isOpenSendOver = false;
  mail.sendAgain.mockReset();
  mail.backToEditing.mockReset();
  navigate.mockReset();
  reading.files = null;
});

describe('a send on the open draft', () => {
  const offered = async (state: Composer['openSendState']) => {
    mail.openSendState = state;
    await act(async () => root.render(<Compose />));
    const labels = ['Send again', 'Back to editing', 'Save to Sent', 'Finish without copy'];
    return [...document.querySelectorAll('button')]
      .map(({ textContent }) => textContent)
      .filter(label => labels.includes(label ?? ''));
  };

  it('offers nothing while it runs', async () => {
    expect(await offered('sending')).toEqual([]);
    expect(alerts()).toEqual(['Sending — this draft is frozen until it finishes.']);
  });

  it('asks about a send nobody saw the answer to', async () => {
    expect(await offered('unconfirmed')).toEqual(['Send again', 'Back to editing']);
    expect(alerts()).toEqual(['This may already have been sent.']);
  });

  it('offers only the copy on one SMTP accepted, so nothing can send it twice', async () => {
    expect(await offered('accepted')).toEqual(['Save to Sent', 'Finish without copy']);
    expect(alerts()).toEqual(['This was sent, but could not be saved to Sent.']);
    const finish = [...document.querySelectorAll('button')].find(
      button => button.textContent === 'Finish without copy',
    );
    await act(async () => finish?.click());
    expect(mail.finishWithoutCopy).toHaveBeenCalledTimes(1);
    await press('Preview');
    expect(buttonNamed('Send')?.disabled).toBe(true);
  });
});

describe('a takeover from the banner', () => {
  const pressOnBanner = async (label: string) => {
    mail.openSendState = label === 'Save to Sent' ? 'accepted' : 'unconfirmed';
    await act(async () => root.render(<Compose />));
    const button = [...document.querySelectorAll('button')].find(
      ({ textContent }) => textContent === label,
    );
    if (button === undefined) throw new Error(`no ${label}`);
    await act(async () => button.click());
  };

  it.each(['Send again', 'Save to Sent'])('%s closes and reports as Send does', async label => {
    const settled = Promise.withResolvers<SendReport>();
    mail.sendAgain.mockResolvedValue({ ok: true, value: { settled: settled.promise } });
    const added = vi.spyOn(toast, 'add');
    await pressOnBanner(label);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sending…' }));
    settled.resolve({ state: 'sent' });
  });

  it('stays open and adds nothing when the send is running after all', async () => {
    mail.sendAgain.mockResolvedValue(null);
    const added = vi.spyOn(toast, 'add');
    await pressOnBanner('Send again');
    expect(navigate).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
  });

  it('says why when it is refused at the claim', async () => {
    mail.sendAgain.mockResolvedValue({
      ok: false,
      error: { kind: 'error', detail: 'That address was removed' },
    });
    await pressOnBanner('Save to Sent');
    expect(navigate).not.toHaveBeenCalled();
    expect(alerts()).toContain('That address was removed');
  });
});

describe('a send that ends on screen', () => {
  it('lets go of the intent, so the composer closes', async () => {
    mail.isOpenSendOver = true;
    await act(async () => root.render(<Compose />));
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

/** Presses Send with the claim held, ends the session, then lets the claim answer. */
const sendAcrossSessionEnd = async (answer: (claim: PromiseWithResolvers<SendAnswer>) => void) => {
  const claim = Promise.withResolvers<SendAnswer>();
  mail.send.mockReturnValue(claim.promise);
  await press('Preview');
  const sendButton = buttonNamed('Send');
  if (sendButton === undefined) throw new Error('the composer offers no Send');
  await act(async () => sendButton.click());
  expect(mail.send).toHaveBeenCalledTimes(1);

  mail.generation += 1;
  await act(async () => {
    answer(claim);
    await claim.promise.catch(() => {});
  });
};

describe('a send whose session ended during its claim', () => {
  it('leaves the next session its composer, and says nothing of the send', async () => {
    const added = vi.spyOn(toast, 'add');
    await sendAcrossSessionEnd(claim =>
      claim.resolve({ ok: true, value: { settled: Promise.resolve({ state: 'ended' }) } }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
  });

  it('shows the next session none of its refusal', async () => {
    await sendAcrossSessionEnd(claim =>
      claim.resolve({ ok: false, error: { kind: 'error', detail: 'smtp.x refused it' } }),
    );
    expect(alerts()).toEqual([]);
  });

  it('shows the next session none of its failure', async () => {
    await sendAcrossSessionEnd(claim => claim.reject(new Error('the vault at x.test is gone')));
    expect(alerts()).toEqual([]);
  });
});

describe('an edit from another device while a Send waits on uploads', () => {
  const resolver = (name: string) =>
    [...document.querySelectorAll('button')].find(button => button.textContent === name);

  afterEach(() => {
    mail.draftConflict = null;
  });

  it('cannot be resolved until the wait ends: their text would go with your files', async () => {
    mail.draftConflict = { draftKey: 'k-1', draftId: 'k-1@2', record: {} };
    const claim = Promise.withResolvers<SendAnswer>();
    mail.send.mockReturnValue(claim.promise);
    await act(async () => root.render(<Compose />));
    await press('Preview');
    expect(resolver('Load theirs')?.disabled).toBe(false);
    expect(resolver('Keep mine')?.disabled).toBe(false);

    const sendButton = resolver('Send');
    await act(async () => sendButton?.click());
    expect(resolver('Load theirs')?.disabled).toBe(true);
    expect(resolver('Keep mine')?.disabled).toBe(true);

    await act(async () =>
      claim.resolve({ ok: false, error: { kind: 'error', detail: 'refused' } }),
    );
    expect(resolver('Load theirs')?.disabled).toBe(false);
  });
});

describe('a send the server refused', () => {
  it('reopens the draft from its toast, and takes the toast off the Send button', async () => {
    const updated = vi.spyOn(toast, 'update');
    const closed = vi.spyOn(toast, 'close');
    mail.send.mockResolvedValue({
      ok: true,
      value: {
        settled: Promise.resolve({ state: 'refused', detail: 'too large', draftKey: 'k-1' }),
      },
    });
    await press('Preview');
    await act(async () => buttonNamed('Send')?.click());
    await act(async () => {});
    const refused = updated.mock.calls.at(-1);
    if (refused === undefined) throw new Error('the refusal was never reported');
    const [id, update] = refused;
    if (typeof update === 'function') throw new Error('the refusal was reported as an updater');
    closed.mockClear();

    await act(async () => update.actionProps?.onClick?.({} as never));

    expect(closed).toHaveBeenCalledWith(id);
    expect(navigate).toHaveBeenCalled();
  });
});

describe('files whose read finishes after the session ended', () => {
  const pick = async () => {
    reading.files = Promise.withResolvers<Attachment[]>();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('the composer offers no file picker');
    const file = new File(['secret'], 'payslip.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    mail.generation += 1;
    return reading.files;
  };

  it('are not attached to the next session’s draft', async () => {
    const read = await pick();
    await act(async () =>
      read.resolve([{ name: 'payslip.pdf', size: 6, kind: 'pdf', content: new Uint8Array(6) }]),
    );
    expect(mail.attach).not.toHaveBeenCalled();
  });

  it('report no failure to the next session', async () => {
    const read = await pick();
    await act(async () => read.reject(new Error('payslip.pdf could not be read')));
    expect(alerts()).toEqual([]);
  });
});

describe("a draft's file chips", () => {
  const stored = { id: 'file-1', name: 'plan.pdf', size: 2048, kind: 'pdf' } as const;
  const showing = async (attachments: ComposeDraft['attachments']) => {
    mail.draft = { ...DRAFT, attachments };
    await act(async () => root.render(<Compose />));
  };
  const chip = () => document.querySelector('li')?.textContent;

  afterEach(() => {
    mail.draft = null;
    mail.retryUpload.mockReset();
    mail.detach.mockReset();
  });

  it('says a file is uploading, and offers to remove it', async () => {
    await showing([{ ...stored, upload: 'uploading' }]);
    expect(chip()).toContain('Uploading…');
    expect(alerts()).toEqual([]);
    const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove plan.pdf"]');
    await act(async () => remove?.click());
    expect(mail.detach).toHaveBeenCalledWith('file-1');
  });

  it('says a stored file is nothing more than itself', async () => {
    await showing([{ ...stored, upload: 'uploaded' }]);
    expect(chip()).toContain('plan.pdf');
    expect(chip()).not.toContain('Upload');
    expect(document.querySelector('[aria-label="Retry plan.pdf"]')).toBeNull();
  });

  it('says an upload failed, in words that are not a connection error, and retries it', async () => {
    await showing([{ ...stored, upload: 'failed', content: new Uint8Array(1) }]);
    expect(chip()).toContain('Upload failed');
    expect(alerts()).toEqual(['Failed to upload. Retry or remove the file.']);
    const retry = document.querySelector<HTMLButtonElement>('[aria-label="Retry plan.pdf"]');
    await act(async () => retry?.click());
    expect(mail.retryUpload).toHaveBeenCalledWith('file-1');
  });

  it('says storage is full apart from any other failure', async () => {
    await showing([{ ...stored, upload: 'storage-full', content: new Uint8Array(1) }]);
    expect(chip()).toContain('Storage full');
    expect(alerts()).toEqual(['Failed to upload. Your file storage is full (1 GB).']);
  });

  it('offers no retry for a file whose bytes this device does not hold', async () => {
    await showing([{ ...stored, upload: 'failed' }]);
    expect(document.querySelector('[aria-label="Retry plan.pdf"]')).toBeNull();
  });
});

describe('a file chip on the preview', () => {
  const failed = {
    id: 'file-1',
    name: 'plan.pdf',
    size: 2048,
    kind: 'pdf',
    upload: 'failed',
    content: new Uint8Array(1),
  } as const;

  afterEach(() => {
    mail.draft = null;
    mail.retryUpload.mockReset();
  });

  it('shows what goes, with no Remove, and still retries a failed upload', async () => {
    mail.draft = { ...DRAFT, attachments: [failed] };
    await act(async () => root.render(<Compose />));
    await press('Preview');
    expect(document.querySelector('li')?.textContent).toContain('plan.pdf');
    expect(document.querySelector('[aria-label="Remove plan.pdf"]')).toBeNull();
    expect(alerts()).toEqual(['Failed to upload. Retry or remove the file.']);
    const retry = document.querySelector<HTMLButtonElement>('[aria-label="Retry plan.pdf"]');
    await act(async () => retry?.click());
    expect(mail.retryUpload).toHaveBeenCalledWith('file-1');
  });
});

/** Opens the composer afresh on `draft`, as seeding it does. */
const opening = async (draft: ComposeDraft) => {
  mail.draft = draft;
  await act(async () => root.render(null));
  await act(async () => root.render(<Compose />));
};

describe('the write step', () => {
  const showing = opening;

  afterEach(() => {
    mail.draft = null;
  });

  it('ends in Preview, the primary action, and offers no Send', async () => {
    await showing(DRAFT);
    expect(buttonNamed('Preview')?.className).toContain('bg-signal');
    expect(buttonNamed('Send')).toBeUndefined();
  });

  it('offers Preview with nothing chosen or addressed, and blames nothing yet', async () => {
    await showing({ ...DRAFT, identityId: '', to: '', subject: '', body: '' });
    expect(buttonNamed('Preview')?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('to send.');
  });

  it('starts a new message at its blank From', async () => {
    await showing({ ...DRAFT, identityId: '', to: '' });
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    expect(isFromFocused()).toBe(true);
  });

  it('focuses the blank From once the addresses load, and never again for that opening', async () => {
    mail.identities = [];
    await showing({ ...DRAFT, identityId: '', to: '' });
    await nextFrame();
    expect(isFromFocused()).toBe(false);

    mail.identities = [ME, RELAY];
    await act(async () => root.render(<Compose />));
    await nextFrame();
    expect(isFromFocused()).toBe(true);

    // Picking an address and moving on to the body leaves the caret where the person put it.
    const body = document.querySelector('textarea');
    body?.focus();
    mail.draft = { ...DRAFT, to: '' };
    await act(async () => root.render(<Compose />));
    await nextFrame();
    expect(document.activeElement).toBe(body);
  });

  it('starts a reply with no From at From, not the body', async () => {
    await showing({ ...DRAFT, identityId: '', startedAsReply: true });
    await nextFrame();
    expect(isFromFocused()).toBe(true);
  });

  it('starts a reopened draft whose address was removed at From', async () => {
    await showing({ ...DRAFT, identityId: 'gone@x.test' });
    await nextFrame();
    expect(isFromFocused()).toBe(true);
  });

  it('leaves focus where it is when a field was clicked into while the addresses loaded', async () => {
    mail.identities = [];
    await showing({ ...DRAFT, identityId: '', to: '' });
    const toField = document.getElementById('compose-to');
    toField?.focus();
    mail.identities = [ME, RELAY];
    await act(async () => root.render(<Compose />));
    await nextFrame();
    expect(document.activeElement).toBe(toField);
    expect(isFromFocused()).toBe(false);
  });

  it('starts a draft whose From is set in To', async () => {
    await showing({ ...DRAFT, to: '' });
    await act(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    expect(document.activeElement?.id).toBe('compose-to');
  });

  it('offers the Markdown cheat sheet in its header, where the message is written', async () => {
    await showing(DRAFT);
    await press('Markdown supported');
    const sheet = document.querySelector('[aria-label="Markdown cheat sheet"]')?.textContent;
    expect(sheet).toContain('**bold**');
    expect(sheet).toContain('[text](url)a link');
  });

  it('has one write surface, set as the message is read', async () => {
    await showing(DRAFT);
    expect(document.querySelector('[role="tab"]')).toBeNull();
    expect(document.querySelector('textarea')?.className).not.toContain('font-mono');
  });

  it('asks nothing of the Subject field until it is empty and focused', async () => {
    await showing(DRAFT);
    expect(document.getElementById('compose-subject')?.getAttribute('placeholder')).toBeNull();
    expect(document.querySelector('textarea')?.getAttribute('placeholder')).toBeNull();
  });

  it('keeps Discard quiet: a ghost that only turns red on hover', async () => {
    await showing(DRAFT);
    const discard = buttonNamed('Discard');
    expect(discard?.className).toContain('text-paper-dim');
    expect(discard?.className).toContain('hover:text-danger');
  });

  it('prints an upload problem as an error, not in the accent', async () => {
    await showing({
      ...DRAFT,
      attachments: [
        {
          id: 'f',
          name: 'plan.pdf',
          size: 1,
          kind: 'pdf',
          upload: 'failed',
          content: new Uint8Array(1),
        },
      ],
    });
    expect(document.querySelector('p[role="alert"]')?.className).toContain('text-danger');
  });
});

describe('the preview step', () => {
  const previewing = async (draft: ComposeDraft) => {
    await opening(draft);
    await press('Preview');
  };
  const envelope = () =>
    Object.fromEntries(
      [...document.querySelectorAll('dl > div')].map(row => [
        row.querySelector('dt')?.textContent,
        row.querySelector('dd')?.textContent,
      ]),
    );
  const title = () => document.querySelector('[role="dialog"] h2')?.textContent;

  afterEach(() => {
    mail.draft = null;
  });

  it('shows the message as it will be read, in place of the write step', async () => {
    await previewing({ ...DRAFT, body: 'Due **Friday**, 2 * 3 boxes.' });
    expect(title()).toBe('Preview');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[role="dialog"] strong')?.textContent).toBe('Friday');
    expect(document.body.textContent).toContain('2 * 3 boxes.');
    expect(buttonNamed('Markdown supported')).toBeUndefined();
  });

  it('shows the envelope: From with its sender and host, To, Subject', async () => {
    await previewing(DRAFT);
    expect(envelope()).toEqual({
      From: 'me@x.testMe Myself · via smtp.x.test',
      To: 'you@x.test',
      Subject: 'Plans',
    });
  });

  it('tags a send-only From', async () => {
    await previewing({ ...DRAFT, identityId: 'news@relay.test' });
    expect(envelope().From).toBe('news@relay.testsend-onlyvia smtp.relay.test');
  });

  it('shows Cc and Bcc only when set, and an empty To only when nobody is addressed', async () => {
    await previewing({ ...DRAFT, to: '', cc: 'a@x.test', bcc: 'b@x.test' });
    expect(Object.keys(envelope())).toEqual(['From', 'Cc', 'Bcc', 'Subject']);
    mail.draft = { ...DRAFT, to: '', subject: '', body: '' };
    await act(async () => root.render(<Compose />));
    expect(envelope()).toMatchObject({ To: '(no recipient)', Subject: '(no subject)' });
    expect(document.body.textContent).toContain('(no message)');
  });

  it('says quietly that no From is chosen', async () => {
    await previewing({ ...DRAFT, identityId: '' });
    expect(envelope().From).toBe('(no address selected)');
  });

  it('sends, when everything is there', async () => {
    mail.send.mockResolvedValue({
      ok: true,
      value: { settled: Promise.resolve({ state: 'sent' }) },
    });
    await previewing(DRAFT);
    expect(buttonNamed('Send')?.disabled).toBe(false);
    await press('Send');
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ identityId: '' }, 'Choose a From address to send.'],
    [{ identityId: 'gone@x.test' }, 'Choose a From address to send.'],
    [{ to: '' }, 'Add a recipient to send.'],
    [{ identityId: '', to: '' }, 'Choose a From address and add a recipient to send.'],
  ])('holds Send for %o and says why', async (change, reason) => {
    await previewing({ ...DRAFT, ...change });
    expect(buttonNamed('Send')?.disabled).toBe(true);
    const line = [...document.querySelectorAll('p')].find(
      ({ textContent }) => textContent === reason,
    );
    // Beside Send, in the row the buttons are in, so the foot does not move when it goes.
    expect(line?.parentElement).toBe(buttonNamed('Send')?.parentElement);
  });

  it('counts a Bcc as a recipient', async () => {
    await previewing({ ...DRAFT, to: '', bcc: 'you@x.test' });
    expect(buttonNamed('Send')?.disabled).toBe(false);
    const silent = [...document.querySelectorAll('p')].find(({ className }) =>
      className.includes('min-h-4'),
    );
    // Below `sm` its line is kept even when it is silent.
    expect(silent?.textContent).toBe('');
  });

  it('does not blame the From or the recipient for a frozen draft', async () => {
    mail.openSendState = 'sending';
    await previewing({ ...DRAFT, identityId: '', to: '' });
    expect(buttonNamed('Send')?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain('to send.');
  });

  it('goes back to the write step as it was left', async () => {
    await previewing({ ...DRAFT, cc: 'a@x.test' });
    await press('Back to writing');
    expect(title()).toBe('New message');
    expect(document.querySelector('textarea')?.value).toBe('Hello');
    expect(document.getElementById('compose-cc')).not.toBeNull();
    expect(document.activeElement).toBe(buttonNamed('Preview'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('returns to the write step from Back to editing on a send nobody saw the answer to', async () => {
    mail.openSendState = 'unconfirmed';
    await previewing(DRAFT);
    expect(title()).toBe('Preview');
    await press('Back to editing');
    expect(mail.backToEditing).toHaveBeenCalledTimes(1);
    expect(title()).toBe('New message');
    expect(document.querySelector('textarea')).not.toBeNull();
  });

  it('steps back on Escape instead of closing', async () => {
    await previewing(DRAFT);
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(title()).toBe('New message');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes, keeping the draft, on ✕', async () => {
    await previewing(DRAFT);
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close draft"]');
    await act(async () => close?.click());
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
