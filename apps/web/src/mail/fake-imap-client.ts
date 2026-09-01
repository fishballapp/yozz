import type { ImapClient, ImapSelected } from '@yozz.app/imap';

/** Answers OK to everything; override what a test asserts on. `live.test.ts` keeps its own fake for IDLE. */
export const stubImapClient = (over: Partial<ImapClient> = {}): ImapClient => {
  const selected = (name: string): ImapSelected => ({
    name,
    exists: 0,
    uidValidity: 1,
    uidNext: 1,
    flags: [],
    permanentFlags: [],
    readOnly: false,
  });
  return {
    greeting: async () => ({ ok: true, value: { text: 'ready', capabilities: [] } }),
    capability: async () => ({ ok: true, value: [] }),
    capabilities: () => [],
    hasCapability: () => true,
    authenticate: async () => ({ ok: true, value: undefined }),
    list: async () => ({ ok: true, value: [] }),
    select: async name => ({ ok: true, value: selected(name) }),
    fetchSummaries: async () => ({ ok: true, value: [] }),
    fetchSummariesBySeq: async () => ({ ok: true, value: [] }),
    fetchFlags: async () => ({ ok: true, value: [] }),
    fetchRaw: async () => ({ ok: true, value: new Uint8Array() }),
    storeFlags: async () => ({ ok: true, value: undefined }),
    append: async () => ({ ok: true, value: null }),
    expunge: async () => ({ ok: true, value: undefined }),
    uidExpunge: async () => ({ ok: true, value: undefined }),
    uidSearchHeader: async () => ({ ok: true, value: [] }),
    move: async () => ({ ok: true, value: undefined }),
    create: async () => ({ ok: true, value: undefined }),
    noop: async () => ({ ok: true, value: undefined }),
    idle: () => ({
      done: async () => ({ ok: true, value: undefined }),
      ended: Promise.resolve({ ok: true, value: undefined }),
    }),
    logout: async () => ({ ok: true, value: undefined }),
    ...over,
  };
};
