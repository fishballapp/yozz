import { describe, expect, it } from 'vitest';
import { DEMO_ADDRESSES, THREADS } from '../dev/fixtures';
import type { Thread } from '../threads/thread';
import type { ComposeDraft } from './draft';
import { composeIntentSchema, isUntouched, replyAllCc, seedFor } from './intent';

/** What gets quoted is per-message; who it reaches is per-thread. The fixtures contain threads whose newest message is outbound. */
const ownedAddresses = DEMO_ADDRESSES.map(address => address.address);

const seed = (intent: string) =>
  seedFor(composeIntentSchema.parse(intent), THREADS, DEMO_ADDRESSES, ownedAddresses);

/** `t-dad` is inbound from Dad, then outbound from Jason. Dad's message carries the attachments. */
const DAD_INBOUND = 'm-dad-1';
const DAD_OWN_REPLY = 'm-dad-2';

describe('seedFor — reply', () => {
  it('quotes the message you pressed, even when it is your own', () => {
    expect(seed(`reply:${DAD_OWN_REPLY}`).body).toContain('Jason Yu <jason@jyu.example> wrote:');
    expect(seed(`reply:${DAD_INBOUND}`).body).toContain('Dad <dad@jyu.example> wrote:');
  });

  it('addresses the other party whichever message you pressed — never yourself', () => {
    // A reply under your own last message is a follow-up to them.
    expect(seed(`reply:${DAD_OWN_REPLY}`).to).toBe('dad@jyu.example');
    expect(seed(`reply:${DAD_INBOUND}`).to).toBe('dad@jyu.example');
    expect(ownedAddresses).not.toContain(seed(`reply:${DAD_OWN_REPLY}`).to);
  });

  it('sends as the address the mail arrived on, whichever message you pressed', () => {
    const arrivedOn = DEMO_ADDRESSES.find(i => i.address === 'jason@jyu.example');
    expect(seed(`reply:${DAD_OWN_REPLY}`).identityId).toBe(arrivedOn?.address);
    expect(seed(`reply:${DAD_INBOUND}`).identityId).toBe(arrivedOn?.address);
  });

  it('does not double the Re: prefix on an already-prefixed subject', () => {
    const subject = seed(`reply:${DAD_INBOUND}`).subject ?? '';
    expect(subject.match(/Re: /g)).toHaveLength(1);
  });
});

describe('seedFor — forward', () => {
  it('carries only the attachments of the message you pressed', () => {
    expect(seed(`forward:${DAD_INBOUND}`).attachments).toHaveLength(3);
    // Jason's reply has none.
    expect(seed(`forward:${DAD_OWN_REPLY}`).attachments).toHaveLength(0);
  });

  it('has no recipient, because forwarding is not a reply', () => {
    expect(seed(`forward:${DAD_INBOUND}`).to).toBeUndefined();
  });

  it('quotes the message you pressed', () => {
    expect(seed(`forward:${DAD_OWN_REPLY}`).body).toContain('Jason Yu');
    expect(seed(`forward:${DAD_OWN_REPLY}`).subject).toMatch(/^Fwd: /);
  });
});

/** A group thread: `recipients` comes off a real envelope, and the demo inbox has none. */
const GROUP: Thread = {
  id: 't-group',
  accounts: ['jason@jyu.example'],
  subject: 'Friday',
  isUnread: false,
  isReplied: false,
  isStarred: false,
  messages: [
    {
      id: 'm-group-1',
      fromName: 'Kate',
      fromAddress: 'kate@example.com',
      toAddress: 'jason@jyu.example',
      recipients: ['jason@jyu.example', 'sam@example.com', 'me@jyu.example', 'kate@example.com'],
      at: 1,
      body: ['See you Friday.'],
    },
  ],
};

const GROUP_OWNED = ['jason@jyu.example', 'me@jyu.example'];

/** A chain; the demo fixtures carry no Message-IDs. */
const CHAIN: Thread = {
  id: 't-chain',
  accounts: ['jason@jyu.example'],
  subject: 'Deploy',
  isUnread: false,
  isReplied: false,
  isStarred: false,
  messages: [
    {
      id: 'm-chain-1',
      fromName: 'Ana',
      fromAddress: 'ana@example.com',
      toAddress: 'jason@jyu.example',
      at: 1,
      body: ['First.'],
      messageId: '<one@example.com>',
    },
    {
      id: 'm-chain-2',
      fromName: 'Ana',
      fromAddress: 'ana@example.com',
      toAddress: 'jason@jyu.example',
      at: 2,
      body: ['Third.'],
      messageId: '<three@example.com>',
      references: ['<one@example.com>', '<two@example.com>'],
    },
  ],
};

describe('seedFor — the References chain', () => {
  const chainSeed = (messageId: string) =>
    seedFor(composeIntentSchema.parse(`reply:${messageId}`), [CHAIN], DEMO_ADDRESSES, GROUP_OWNED);

  it("announces the parent's chain and then the parent", () => {
    expect(chainSeed('m-chain-2')).toMatchObject({
      inReplyTo: '<three@example.com>',
      references: ['<one@example.com>', '<two@example.com>', '<three@example.com>'],
    });
  });

  it('is the parent alone when the parent referenced nothing', () => {
    expect(chainSeed('m-chain-1')).toMatchObject({
      inReplyTo: '<one@example.com>',
      references: ['<one@example.com>'],
    });
  });

  it('never repeats an id a sloppy sender already repeated', () => {
    const repeated: Thread = {
      ...CHAIN,
      messages: [
        { ...CHAIN.messages[0], references: ['<one@example.com>'] } as Thread['messages'][number],
      ],
    };
    expect(
      seedFor(
        composeIntentSchema.parse('reply:m-chain-1'),
        [repeated],
        DEMO_ADDRESSES,
        GROUP_OWNED,
      ),
    ).toMatchObject({ references: ['<one@example.com>'] });
  });
});

describe('replyAllCc', () => {
  it('keeps the others and drops every address you own, plus the sender', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(replyAllCc(message, GROUP_OWNED)).toEqual(['sam@example.com']);
    // Case is not a difference between addresses.
    expect(
      replyAllCc({ ...message, recipients: ['SAM@Example.com', 'Jason@JYu.example'] }, GROUP_OWNED),
    ).toEqual(['SAM@Example.com']);
  });

  it('is empty when the message was to you alone — the answer to whether to offer it', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(replyAllCc({ ...message, recipients: ['jason@jyu.example'] }, GROUP_OWNED)).toEqual([]);
    // Fixture mail carries no envelope to read recipients from.
    expect(replyAllCc({ ...message, recipients: undefined }, GROUP_OWNED)).toEqual([]);
  });
});

describe('seedFor — reply all', () => {
  const seedGroup = (intent: string) =>
    seedFor(composeIntentSchema.parse(intent), [GROUP], DEMO_ADDRESSES, GROUP_OWNED);

  it('addresses the sender and copies everyone else the mail reached', () => {
    expect(seedGroup('reply-all:m-group-1').to).toBe('kate@example.com');
    expect(seedGroup('reply-all:m-group-1').cc).toBe('sam@example.com');
  });

  it('is a plain reply in every other respect', () => {
    expect(seedGroup('reply-all:m-group-1').subject).toBe('Re: Friday');
    expect(seedGroup('reply-all:m-group-1').body).toContain('Kate <kate@example.com> wrote:');
    // Reply is the same mail without the copies.
    expect(seedGroup('reply:m-group-1').cc).toBeUndefined();
  });
});

describe('seedFor — degenerate intents', () => {
  it('opens a blank draft for `new`', () => {
    expect(seed('new')).toEqual({});
  });

  it('degrades a stale message reference to a blank draft rather than erroring', () => {
    // Reachable only from a pasted or bookmarked URL.
    expect(seed('reply:m-does-not-exist')).toEqual({});
  });
});

describe('composeIntentSchema', () => {
  it('accepts the five shapes and rejects everything else', () => {
    for (const ok of ['new', 'reply:m-1', 'reply-all:m-1', 'forward:m-1', 'draft:k-1']) {
      expect(composeIntentSchema.safeParse(ok).success).toBe(true);
    }
    // A junk `?compose=` reads as closed.
    for (const bad of [
      'reply:',
      'reply-all:',
      'forward:',
      'reply',
      'draft:',
      '',
      'NEW',
      42,
      null,
    ]) {
      expect(composeIntentSchema.safeParse(bad).success).toBe(false);
    }
  });
});

/** What stands between a mistaken Reply and a record in Drafts. */
describe('isUntouched', () => {
  const opened: ComposeDraft = {
    startedAsReply: true,
    identityId: 'me@x',
    to: 'dana@x',
    cc: '',
    bcc: '',
    subject: 'Re: sync',
    body: '> Thursday 10:00 is fine by me.',
    attachments: [],
  };

  it('is true for a reply nobody typed into, whose fields are full from the moment it opens', () => {
    expect(isUntouched({ ...opened }, opened)).toBe(true);
  });

  it('is false once a single character reaches any field', () => {
    expect(isUntouched({ ...opened, body: `Yes.\n\n${opened.body}` }, opened)).toBe(false);
    expect(isUntouched({ ...opened, cc: 'sam@x' }, opened)).toBe(false);
    expect(isUntouched({ ...opened, subject: 'Re: sync?' }, opened)).toBe(false);
  });

  it('is false for an attachment alone, which is writing with no text in it', () => {
    const attached = {
      ...opened,
      attachments: [{ name: 'f.pdf', size: 3, kind: 'pdf' as const, content: new Uint8Array(3) }],
    };
    expect(isUntouched(attached, opened)).toBe(false);
  });
});
