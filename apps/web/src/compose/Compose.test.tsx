// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Composer } from '../store/use-composer';
import type { Attachment } from '../threads/thread';
import { toast } from '../ui/Toast';
import { Compose } from './Compose';
import type { ComposeDraft } from './draft';

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
}));
const navigate = vi.hoisted(() => vi.fn());
const reading = vi.hoisted(() => ({ files: null as PromiseWithResolvers<Attachment[]> | null }));

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ compose: 'new' }),
  useNavigate: () => navigate,
}));
vi.mock('../vault/session', () => ({ useVault: () => ({ session: { userId: 'user-1' } }) }));
vi.mock('./draft', async importOriginal => ({
  ...(await importOriginal<typeof import('./draft')>()),
  readAttachments: () => reading.files?.promise,
}));
vi.mock('../store/MailProvider', () => ({
  useMail: () => ({
    draft: DRAFT,
    seedDraft: () => DRAFT,
    updateDraft: vi.fn(),
    send: mail.send,
    attach: mail.attach,
    detach: vi.fn(),
    threads: [],
    identities: [],
    ownedAddresses: [],
    drafts: [],
    draftConflict: null,
    draftError: null,
    resolveDraftConflict: vi.fn(),
    openSendState: null,
    sendAgain: vi.fn(),
    backToEditing: vi.fn(),
    discardDraft: vi.fn(),
    watchSession: () => {
      const taken = mail.generation;
      return () => mail.generation === taken;
    },
  }),
}));

const root = createRoot(document.createElement('div'));

beforeEach(async () => {
  mail.generation = 0;
  await act(async () => root.render(<Compose />));
});

afterEach(async () => {
  await act(async () => root.render(null));
  vi.restoreAllMocks();
  mail.send.mockReset();
  mail.attach.mockReset();
  navigate.mockReset();
  reading.files = null;
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
