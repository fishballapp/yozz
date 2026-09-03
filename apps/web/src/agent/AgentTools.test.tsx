// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTools } from './AgentTools';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(async () => {}),
  useParams: () => ({ mailbox: 'unified' }),
}));

vi.mock('../store/MailProvider', async importOriginal => ({
  ...(await importOriginal<typeof import('../store/MailProvider')>()),
  useMail: () => ({
    identities: [{ address: 'me@yozz.app', imap: { host: 'imap', port: 993 } }],
    threads: [],
    draft: null,
    loadBody: vi.fn(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
    toggleArchive: vi.fn(),
    toggleStar: vi.fn(),
    restoreThread: vi.fn(),
  }),
}));

type Registered = { tool: { name: string }; signal: AbortSignal | undefined };

const withModelContext = (registerTool: (...args: unknown[]) => Promise<undefined>) => {
  Object.defineProperty(document, 'modelContext', {
    value: { registerTool },
    configurable: true,
  });
};

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext');
});

const mount = async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<AgentTools />));
  return () => act(async () => root.unmount());
};

describe('AgentTools', () => {
  it('registers every tool under one signal and aborts it on unmount', async () => {
    const registered: Registered[] = [];
    withModelContext(async (tool, options) => {
      registered.push({
        tool: tool as { name: string },
        signal: (options as { signal?: AbortSignal } | undefined)?.signal,
      });
      return undefined;
    });

    const unmount = await mount();
    expect(registered.map(({ tool }) => tool.name)).toHaveLength(6);
    const signal = registered[0]?.signal;
    if (signal === undefined) throw new Error('no signal');
    expect(registered.every(entry => entry.signal === signal)).toBe(true);
    expect(signal.aborted).toBe(false);

    await unmount();
    expect(signal.aborted).toBe(true);
  });

  it('mounts silently where there is no modelContext, and warns on a refused tool', async () => {
    const unmountQuiet = await mount();
    await unmountQuiet();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withModelContext(async () => {
      throw new DOMException('duplicate', 'InvalidStateError');
    });
    const unmount = await mount();
    expect(warn).toHaveBeenCalledTimes(6);
    await unmount();
    warn.mockRestore();
  });
});
