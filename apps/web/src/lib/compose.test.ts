import { describe, expect, it } from 'vitest';
import { DEMO_ADDRESSES, THREADS } from '../data/mail';
import { composeIntentSchema, replyAllCc, seedFor } from './compose';
import type { Thread } from './thread';

/**
 * `seedFor` encodes the one rule in this app that is easy to break and impossible to see break:
 * **what gets quoted is per-message, but who it reaches is per-thread.** A regression here sends a
 * reply to yourself, or forwards someone else's attachments, and nothing fails loudly.
 *
 * Run against the real fixtures rather than invented ones, because the fixture inbox deliberately
 * contains the awkward case — threads whose newest message is outbound.
 */
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
    // The whole point: a reply under your own last message is a FOLLOW-UP to them.
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
    // Jason's reply has none. Before this was per-message, forwarding it grabbed Dad's three.
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

/**
 * A group thread, built here rather than taken from the fixtures: `recipients` comes off a real
 * IMAP envelope, and the demo inbox has none. Kate wrote to Jason with two others copied, one of
 * them a second address Jason owns.
 */
const GROUP: Thread = {
  id: 't-group',
  accountId: 'jason@jyu.example',
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

describe('replyAllCc', () => {
  it('keeps the others and drops every address you own, plus the sender', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(replyAllCc(message, GROUP_OWNED)).toEqual(['sam@example.com']);
    // Case is not a difference between addresses, and a server may send either.
    expect(
      replyAllCc({ ...message, recipients: ['SAM@Example.com', 'Jason@JYu.example'] }, GROUP_OWNED),
    ).toEqual(['SAM@Example.com']);
  });

  it('is empty when the message was to you alone — the answer to whether to offer it', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(replyAllCc({ ...message, recipients: ['jason@jyu.example'] }, GROUP_OWNED)).toEqual([]);
    // Fixture mail carries no envelope to read recipients from; that is not a group.
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
    // Deliberate: the intent was "write something" and only the reference went stale. Reachable
    // only from a pasted or bookmarked URL.
    expect(seed('reply:m-does-not-exist')).toEqual({});
  });
});

describe('composeIntentSchema', () => {
  it('accepts the four shapes and rejects everything else', () => {
    for (const ok of ['new', 'reply:m-1', 'reply-all:m-1', 'forward:m-1']) {
      expect(composeIntentSchema.safeParse(ok).success).toBe(true);
    }
    // A junk `?compose=` must read as "closed", never throw or open something empty.
    for (const bad of [
      'reply:',
      'reply-all:',
      'forward:',
      'reply',
      'draft:m-1',
      '',
      'NEW',
      42,
      null,
    ]) {
      expect(composeIntentSchema.safeParse(bad).success).toBe(false);
    }
  });
});
