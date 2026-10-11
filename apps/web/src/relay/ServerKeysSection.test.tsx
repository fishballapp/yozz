// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetPin, listPins } from './peer-store';
import { ServerKeysSection } from './ServerKeysSection';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  identities: [] as unknown[],
}));

vi.mock('../store/MailProvider', () => ({ useMail: () => ({ identities: mocks.identities }) }));
vi.mock('./peer-store', () => ({ listPins: vi.fn(), forgetPin: vi.fn() }));
// The real one is a Base UI portal; modelled as the controlled question it is here.
vi.mock('../ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    title,
    confirmLabel,
    onConfirm,
    onOpenChange,
  }: {
    title: string;
    confirmLabel: string;
    onConfirm: () => Promise<void>;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div role="alertdialog">
      <h2>{title}</h2>
      <button
        type="button"
        onClick={() =>
          void onConfirm().then(
            () => onOpenChange(false),
            () => {},
          )
        }
      >
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
  await act(async () => root.render(<ServerKeysSection />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

const addressAt = (imap: string, smtp: string) => ({
  address: `me@${imap}`,
  imap: { host: imap, port: 993 },
  smtp: { host: smtp, port: 465 },
});

beforeEach(() => {
  mocks.identities = [addressAt('imap.mine.test', 'smtp.mine.test')];
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.resetAllMocks();
});

describe('ServerKeysSection', () => {
  it('renders nothing when every pinned server is one an address uses', async () => {
    vi.mocked(listPins).mockResolvedValue([{ peer: 'imap.mine.test:993', pin: 'a' }]);
    const host = await mount();
    expect(host.textContent).toBe('');
  });

  it('lists only the servers no address uses', async () => {
    vi.mocked(listPins).mockResolvedValue([
      { peer: 'imap.mine.test:993', pin: 'a' },
      { peer: 'mx.elsewhere.test:465', pin: 'b' },
    ]);
    const host = await mount();
    expect(host.textContent).toContain('mx.elsewhere.test:465');
    expect(host.textContent).not.toContain('imap.mine.test');
  });

  it('asks before forgetting, and forgets the key once confirmed', async () => {
    vi.mocked(listPins)
      .mockResolvedValueOnce([{ peer: 'mx.elsewhere.test:465', pin: 'b' }])
      .mockResolvedValue([]);
    vi.mocked(forgetPin).mockResolvedValue();
    const host = await mount();
    // Text, not a bin: the same words as the address page's server rows.
    expect(host.querySelector('button[aria-label]')?.textContent).toBe('Forget key');

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label]')?.click();
    });
    expect(document.body.textContent).toContain('Forget the key for mx.elsewhere.test:465?');
    expect(forgetPin).not.toHaveBeenCalled();

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('[role$="dialog"] button')]
        .find(candidate => candidate.textContent === 'Forget key')
        ?.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(forgetPin).toHaveBeenCalledWith('mx.elsewhere.test:465');
    expect(host.textContent).toBe('');
  });
});
