// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestSignupLink } from './auth-client';
import { Welcome } from './Welcome';

// @ts-expect-error React reads it off the global
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/login">{children}</a>,
}));
vi.mock('./api-base-url', () => ({
  isApiConfigured: () => true,
  getApiBaseUrl: () => 'http://localhost',
}));
vi.mock('./auth-client', () => ({ requestSignupLink: vi.fn(async () => ({ error: null })) }));

const unmounts: (() => Promise<void>)[] = [];

const mount = async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Welcome />));
  unmounts.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
};

const buttonStartingWith = (page: HTMLElement, text: string) => {
  const button = [...page.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.startsWith(text),
  );
  if (button === undefined) throw new Error(`no button "${text}…"`);
  return button;
};

/** Types an address and sends the first link. */
const sendLink = async (page: HTMLElement) => {
  const input = page.querySelector<HTMLInputElement>('#welcome-email');
  if (input === null) throw new Error('no email field');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'jason@example.com',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => page.querySelector('form')?.requestSubmit());
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Welcome', () => {
  it('says what happens next and that the address is for keeps', async () => {
    const page = await mount();
    expect(page.querySelector('ol [aria-current="step"]')?.textContent).toBe('1Email');
    // Why it is safe, within what ARCHITECTURE.md permits, with its boundary beside it.
    expect(page.textContent).toContain('Your mail stays wherever it already lives.');
    expect(page.textContent).toContain('encrypted on your device before YOZZ stores them');
    // The password does reach the mail server, so no line may say it never leaves the device.
    expect(page.textContent).not.toContain('never leave');
    expect(page.textContent).toContain("YOZZ doesn't add end-to-end encryption.");
    expect(page.textContent).not.toMatch(/free|beta|price/i);
    expect(buttonStartingWith(page, 'Continue with email').type).toBe('submit');
    expect(page.querySelector('#welcome-email')?.getAttribute('aria-describedby')).toBe(
      'welcome-email-hint',
    );
    const hint = page.querySelector('#welcome-email-hint');
    expect(hint?.textContent).toBe("This is your YOZZ login. It can't be changed later.");
    // Read before the press: between the field and the button, not under it.
    const submit = buttonStartingWith(page, 'Continue with email');
    expect(hint?.compareDocumentPosition(submit)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(page.querySelector('label[for="welcome-email"]')?.textContent).toBe('Your email');
  });

  it('names the sender, and offers a resend only after 30 seconds', async () => {
    const page = await mount();
    await sendLink(page);
    expect(page.textContent).toContain('jason@example.com from no-reply@yozz.app');

    const resend = buttonStartingWith(page, 'Resend link');
    expect(resend.textContent).toBe('Resend link in 30s');
    expect(resend.disabled).toBe(true);

    for (let second = 0; second < 30; second += 1) {
      await act(async () => vi.advanceTimersByTime(1000));
    }
    expect(resend.textContent).toBe('Resend link');
    expect(resend.disabled).toBe(false);

    await act(async () => resend.click());
    expect(requestSignupLink).toHaveBeenCalledTimes(2);
    expect(requestSignupLink).toHaveBeenLastCalledWith('jason@example.com');
    expect(page.querySelector('[role="status"]')?.textContent).toBe('Sent again.');
    expect(resend.textContent).toBe('Resend link in 30s');
  });
});
