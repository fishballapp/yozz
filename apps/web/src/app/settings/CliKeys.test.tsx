// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AccountCliKey, listCliKeys, revokeCliKey } from '../../vault/cli-keys';
import type { UnlockedVaultSession } from '../../vault/unlock';
import { CliKeysSection } from './CliKeys';
import type { Action } from './SignInChange';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../vault/cli-keys', () => ({
  listCliKeys: vi.fn(async () => []),
  revokeCliKey: vi.fn(async () => {}),
}));
// The real one is a Base UI portal; modelled as the controlled question this section asks.
vi.mock('../../ui/ConfirmDialog', () => ({
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

const session = { userId: 'user-alice', store: {} } as UnlockedVaultSession;

const KEY: AccountCliKey = {
  keyId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  name: 'jasons-mbp',
  publicKey: 'unused',
  pairingCode: 'K7Q2-M9XD',
  createdAt: Date.UTC(2026, 9, 30),
  lastUsedAt: null,
};

/** Runs the action as `useSignInChange` would, for a session that stays open. */
const run = vi.fn(async (_area: 'cliKeys', action: Action) => {
  await action(() => true);
  return null;
});

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<CliKeysSection session={session} isBusy={false} error={undefined} run={run} />),
  );
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
};

const text = () => document.body.textContent ?? '';

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

beforeEach(() => {
  vi.mocked(listCliKeys).mockReset().mockResolvedValue([]);
  vi.mocked(revokeCliKey).mockReset().mockResolvedValue();
  run.mockClear();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

describe('CliKeysSection', () => {
  it('says nothing about the keys until the list arrives', async () => {
    vi.mocked(listCliKeys).mockReturnValue(new Promise(() => {}));
    await mount();
    expect(text()).not.toContain('No CLI keys yet');
    expect(document.querySelector('ul')).toBeNull();
  });

  it('says how to add one when there are none', async () => {
    await mount();
    expect(text()).toContain('No CLI keys yet. Run yozz login in a terminal to add one.');
  });

  it('lists each key by name, with the code its terminal showed, when it was added and last used', async () => {
    vi.mocked(listCliKeys).mockResolvedValue([
      KEY,
      { ...KEY, keyId: crypto.randomUUID(), name: 'ci', lastUsedAt: Date.UTC(2026, 9, 31) },
    ]);
    await mount();
    const rows = [...document.querySelectorAll('li')].map(row => row.textContent);
    expect(rows).toEqual([
      'jasons-mbpK7Q2-M9XD · Added 30 Oct 2026 · Never usedRevoke',
      'ciK7Q2-M9XD · Added 30 Oct 2026 · Last used 31 Oct 2026Revoke',
    ]);
    expect(text()).not.toContain('No CLI keys yet');
  });

  it('says why when the list cannot be read', async () => {
    vi.mocked(listCliKeys).mockRejectedValue(new Error('The YOZZ API did not answer.'));
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'The YOZZ API did not answer.',
    );
  });

  it('asks before revoking, then revokes through the sign-in change and reads the list again', async () => {
    vi.mocked(listCliKeys).mockResolvedValue([KEY]);
    await mount();
    await click('Revoke');
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'yozz on jasons-mbp (K7Q2-M9XD) can no longer open your mail.',
    );
    expect(revokeCliKey).not.toHaveBeenCalled();

    vi.mocked(listCliKeys).mockResolvedValue([]);
    await click('Revoke key');
    expect(run).toHaveBeenCalledWith('cliKeys', expect.any(Function));
    expect(revokeCliKey).toHaveBeenCalledWith({ userId: 'user-alice', keyId: KEY.keyId });
    expect(text()).toContain('No CLI keys yet');
  });
});
