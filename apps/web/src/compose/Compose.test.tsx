// @vitest-environment jsdom

import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { Attachment } from '@yozz.app/mail/threads/thread';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composer } from '../store/use-composer';
import { toast } from '../ui/Toast';
import { Compose } from './Compose';
import type { SendReport } from './draft';

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

/** The store as the composer sees it; `generation` is what a lock or a sign-in moves on. */
const mail = vi.hoisted(() => ({
  generation: 0,
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
    identities: [],
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

beforeEach(async () => {
  mail.generation = 0;
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
    const send = [...document.querySelectorAll('button')].find(
      button => button.textContent === 'Send',
    );
    expect(send?.disabled).toBe(true);
  });
});

describe('a takeover from the banner', () => {
  const press = async (label: string) => {
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
    await press(label);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sending…' }));
    settled.resolve({ state: 'sent' });
  });

  it('stays open and adds nothing when the send is running after all', async () => {
    mail.sendAgain.mockResolvedValue(null);
    const added = vi.spyOn(toast, 'add');
    await press('Send again');
    expect(navigate).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
  });

  it('says why when it is refused at the claim', async () => {
    mail.sendAgain.mockResolvedValue({
      ok: false,
      error: { kind: 'error', detail: 'That address was removed' },
    });
    await press('Save to Sent');
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

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent);

/** Presses Send with the claim held, ends the session, then lets the claim answer. */
const sendAcrossSessionEnd = async (answer: (claim: PromiseWithResolvers<SendAnswer>) => void) => {
  const claim = Promise.withResolvers<SendAnswer>();
  mail.send.mockReturnValue(claim.promise);
  const sendButton = [...document.querySelectorAll('button')].find(
    button => button.textContent === 'Send',
  );
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
    const sendButton = [...document.querySelectorAll('button')].find(
      button => button.textContent === 'Send',
    );
    await act(async () => sendButton?.click());
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

describe('the composer’s footer', () => {
  const showing = async (draft: ComposeDraft) => {
    mail.draft = draft;
    await act(async () => root.render(<Compose />));
  };
  const send = () =>
    [...document.querySelectorAll('button')].find(({ textContent }) => textContent === 'Send');

  afterEach(() => {
    mail.draft = null;
  });

  it('says why Send is off until someone is addressed', async () => {
    await showing({ ...DRAFT, to: '' });
    expect(send()?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Add a recipient to send.');
  });

  it('keeps the reason beside Send, in the row the buttons are in, so the foot does not move', async () => {
    await showing({ ...DRAFT, to: '' });
    const reason = [...document.querySelectorAll('p')].find(
      ({ textContent }) => textContent === 'Add a recipient to send.',
    );
    expect(reason?.parentElement).toBe(send()?.parentElement);
    // Below `sm` its line is kept even when it is silent.
    await showing({ ...DRAFT, to: 'you@x.test' });
    const silent = [...document.querySelectorAll('p')].find(({ className }) =>
      className.includes('min-h-4'),
    );
    expect(silent?.textContent).toBe('');
  });

  it('says nothing once there is a recipient, a Bcc counting as one', async () => {
    await showing({ ...DRAFT, to: '', bcc: 'you@x.test' });
    expect(send()?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Add a recipient to send.');
  });

  it('does not blame the recipient for a frozen draft', async () => {
    mail.openSendState = 'sending';
    await showing({ ...DRAFT, to: '' });
    expect(document.body.textContent).not.toContain('Add a recipient to send.');
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

  it('asks nothing of the Subject field until it is empty and focused', async () => {
    await showing(DRAFT);
    expect(document.getElementById('compose-subject')?.getAttribute('placeholder')).toBeNull();
  });

  it('keeps Discard quiet: a ghost that only turns red on hover', async () => {
    await showing(DRAFT);
    const discard = [...document.querySelectorAll('button')].find(
      ({ textContent }) => textContent === 'Discard',
    );
    expect(discard?.className).toContain('text-paper-dim');
    expect(discard?.className).toContain('hover:text-danger');
  });

  it('offers a Markdown cheat sheet instead of a bare label', async () => {
    await showing(DRAFT);
    const trigger = [...document.querySelectorAll('button')].find(
      ({ textContent }) => textContent === 'Markdown supported',
    );
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      trigger?.click();
    });
    const sheet = document.querySelector('[aria-label="Markdown cheat sheet"]')?.textContent;
    expect(sheet).toContain('**bold**');
    expect(sheet).toContain('[text](url)a link');
  });
});
