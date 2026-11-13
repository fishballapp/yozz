// @vitest-environment jsdom

import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Compose } from './Compose';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT: ComposeDraft = {
  startedAsReply: true,
  identityId: 'me@x.test',
  to: 'dad@family.example',
  cc: '',
  bcc: '',
  subject: 'Re: Sunday',
  body: '> Hello.',
  attachments: [],
};

const route = vi.hoisted(() => ({ compose: 'new' }));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ compose: route.compose }),
  useNavigate: () => vi.fn(),
  useLocation: () => '/m/unified/t/t',
}));
vi.mock('../vault/session', () => ({ useVault: () => ({ session: { userId: 'user-1' } }) }));
vi.mock('../store/MailProvider', () => ({
  useComposer: () => ({
    draft: DRAFT,
    seedDraft: () => DRAFT,
    updateDraft: vi.fn(),
    send: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    retryUpload: vi.fn(),
    draftConflict: null,
    draftError: null,
    resolveDraftConflict: vi.fn(),
    openSendState: null,
    isOpenDraftFrozen: false,
    isOpenSendOver: false,
    sendAgain: vi.fn(),
    backToEditing: vi.fn(),
    finishWithoutCopy: vi.fn(),
    discardDraft: vi.fn(),
  }),
  useMail: () => ({
    threads: [
      {
        id: 't',
        subject: 'Sunday',
        messages: [
          {
            id: 'm-1',
            fromName: 'Dad',
            fromAddress: 'dad@family.example',
            toAddress: 'me@x.test',
            at: 0,
            body: ['Hello.'],
          },
        ],
      },
    ],
    identities: [],
    ownedAddresses: ['me@x.test'],
    drafts: [],
    readStoredFile: async () => null,
    watchSession: () => () => true,
  }),
}));

const PANE_LEFT = 832;
let root: Root;

/** jsdom lays nothing out: the reader pane is an element that says where it starts. */
const mountReaderPane = () => {
  const pane = document.createElement('section');
  pane.dataset.readerPane = '';
  pane.getBoundingClientRect = () => ({ left: PANE_LEFT }) as DOMRect;
  document.body.append(pane);
};

const open = async (compose: string, { isWide }: { isWide: boolean }) => {
  route.compose = compose;
  vi.stubGlobal('matchMedia', () => ({
    matches: isWide,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  await act(async () => root.render(<Compose />));
  const popup = document.querySelector<HTMLElement>('[role="dialog"]');
  if (popup === null) throw new Error('the composer did not open');
  return {
    isDocked: popup.dataset.docked !== undefined,
    width: popup.parentElement?.style.width,
    title: popup.querySelector('h2')?.textContent,
    // Base UI marks the rest of the page inert for a modal dialog; a docked one leaves it live.
    hasBackdrop: document.querySelector('[role="presentation"].bg-ink\\/75') !== null,
  };
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('where the composer opens', () => {
  it.each(['reply:m-1', 'reply-all:m-1', 'forward:m-1'])(
    'docks %s up to the reader pane from `lg`, with no scrim',
    async intent => {
      mountReaderPane();
      const composer = await open(intent, { isWide: true });
      expect(composer).toMatchObject({
        isDocked: true,
        width: `${PANE_LEFT}px`,
        hasBackdrop: false,
      });
    },
  );

  it('centres a new message, an unsubscribe and a stored draft', async () => {
    mountReaderPane();
    for (const intent of ['new', 'unsubscribe:m-1']) {
      const composer = await open(intent, { isWide: true });
      expect(composer).toMatchObject({ isDocked: false, width: '', hasBackdrop: true });
    }
  });

  it('centres a reply below `lg`', async () => {
    mountReaderPane();
    const composer = await open('reply:m-1', { isWide: false });
    expect(composer).toMatchObject({ isDocked: false, hasBackdrop: true });
  });

  it('centres a reply with no reader pane on screen, as on Settings', async () => {
    const composer = await open('reply:m-1', { isWide: true });
    expect(composer).toMatchObject({ isDocked: false, hasBackdrop: true });
  });

  it('is titled from the intent in either shape', async () => {
    mountReaderPane();
    expect((await open('reply:m-1', { isWide: true })).title).toBe('Reply to Dad');
    expect((await open('forward:m-1', { isWide: false })).title).toBe('Forward');
    expect((await open('new', { isWide: true })).title).toBe('New message');
  });
});

describe('how wide a line of the body runs', () => {
  const body = () => document.querySelector('textarea')?.className ?? '';

  it('is held to a measure when docked, where the pane is as wide as the list and the rail', async () => {
    mountReaderPane();
    await open('reply:m-1', { isWide: true });
    expect(body()).toContain('max-w-[80ch]');
  });

  it('is left to the centred modal, which is already narrow', async () => {
    mountReaderPane();
    await open('new', { isWide: true });
    expect(body()).not.toContain('max-w-[80ch]');
  });
});
