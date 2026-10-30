// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveCliLogin, parseCliApproveQuery } from '../vault/cli-keys';
import { CliApprove } from './CliApprove';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const QUERY = { port: 53682, state: 'S'.repeat(43), publicKey: 'unused', name: 'jasons-mbp' };

const mocks = vi.hoisted(() => ({
  session: null as unknown,
}));

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => <a href={to}>redirect</a>,
}));
vi.mock('../vault/session', () => ({
  useVault: () => ({ session: mocks.session, isResuming: false }),
}));
vi.mock('../store/MailProvider', () => ({
  useMail: () => ({ watchSession: () => () => true }),
}));
vi.mock('../vault/cli-keys', () => ({
  parseCliApproveQuery: vi.fn(() => null),
  approveCliLogin: vi.fn(),
  cliCallbackUrl: vi.fn(() => 'http://127.0.0.1:53682/callback'),
}));
vi.mock('@yozz.app/vault', () => ({ pairingCode: async () => 'K7Q2-M9XD' }));
vi.mock('../vault/unlock', () => ({
  needsFreshSession: (error: unknown) => error === 'not fresh',
  confirmIdentity: vi.fn(async () => {}),
}));
vi.mock('../vault/api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://api.test',
}));
// The real one is a Base UI portal; modelled as the controlled question Confirm it's you asks.
vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
  }) =>
    open && (
      <div role="alertdialog">
        <h2>{title}</h2>
        <p>{description}</p>
        <button type="button" onClick={() => void onConfirm().catch(() => {})}>
          {confirmLabel}
        </button>
      </div>
    ),
}));

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<CliApprove search="?port=53682" />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const click = async (label: string) => {
  const found = [...document.body.querySelectorAll('button')].findLast(
    candidate => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  await act(async () => {
    found.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

/** The command, wherever the page names it, is a mono machine value. */
const monoCommands = () =>
  [...document.querySelectorAll('.font-mono')].filter(node => node.textContent === 'yozz login');

beforeEach(() => {
  mocks.session = { userId: 'user-alice', email: 'alice@example.com', mode: 'password', store: {} };
  vi.mocked(parseCliApproveQuery).mockReturnValue(QUERY);
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.clearAllMocks();
});

describe('CliApprove', () => {
  it('sets yozz login in mono where it explains a link it did not make', async () => {
    vi.mocked(parseCliApproveQuery).mockReturnValue(null);
    await mount();
    expect(document.body.textContent).toContain('This link isn’t a YOZZ CLI approval');
    expect(monoCommands()).toHaveLength(2);
  });

  it('sets yozz login in mono where it says who is asking', async () => {
    await mount();
    expect(document.body.textContent).toContain(
      'yozz login is asking to open your mail from a terminal.',
    );
    expect(monoCommands()).toHaveLength(1);
  });

  it('says the change is approving a CLI when Approve asked for a fresh sign-in, then approves', async () => {
    vi.mocked(approveCliLogin)
      .mockRejectedValueOnce('not fresh')
      .mockResolvedValueOnce({ outcome: 'ended' });
    await mount();
    await click('Approve');
    expect(document.body.textContent).toContain('Approving a CLI needs a fresh sign-in');
    expect(document.body.textContent).not.toContain('Changing how you sign in');

    await click('Confirm');
    expect(approveCliLogin).toHaveBeenCalledTimes(2);
  });
});
