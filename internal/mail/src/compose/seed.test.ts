import { describe, expect, it } from 'vitest';
import type { AddressRecord } from '../addresses/record.ts';
import type { Thread } from '../threads/thread.ts';
import { replyAllCc, type SeedRequest, seedFor } from './seed.ts';

/** `kind:messageId`, as a link or a command names it. */
const request = (intent: string): SeedRequest => {
  const at = intent.indexOf(':');
  return { kind: intent.slice(0, at) as SeedRequest['kind'], messageId: intent.slice(at + 1) };
};

const SERVERS = { host: 'mail.example', username: 'jason', password: 'secret' };
const ADDRESSES: readonly AddressRecord[] = [
  {
    address: 'jason@jyu.example',
    senderName: 'Jason Yu',
    smtp: { ...SERVERS, port: 465 },
    imap: { ...SERVERS, port: 993 },
  },
  {
    address: 'jason@northlane.example',
    senderName: 'Jason Yu',
    smtp: { ...SERVERS, port: 465 },
    imap: { ...SERVERS, port: 993 },
  },
];

/** What gets quoted is per-message; who it reaches is per-thread. */
const ownedAddresses = ADDRESSES.map(address => address.address);

/** Inbound from Dad, then outbound from Jason, so its newest message is your own. Dad's carries the attachments. */
const DAD: Thread = {
  id: 't-dad',
  mailboxes: ['jason@jyu.example'],
  subject: 'Photos from the weekend',
  isUnread: false,
  isReplied: true,
  isStarred: false,
  messages: [
    {
      id: 'm-dad-1',
      fromName: 'Dad',
      fromAddress: 'dad@jyu.example',
      toAddress: 'jason@jyu.example',
      to: [
        { name: 'Jason', address: 'jason@jyu.example' },
        { name: 'Mei', address: 'mei.yu@gmail.com' },
      ],
      at: 1,
      body: ['Got some good ones of the dog at the beach.'],
      attachments: [
        { name: 'beach-dog-01.jpg', size: 3, kind: 'image', mimeType: 'image/jpeg' },
        { name: 'beach-dog-stick.jpg', size: 3, kind: 'other' },
        { name: 'weekend-originals.zip', size: 48_234_496, kind: 'archive' },
      ],
    },
    {
      id: 'm-dad-2',
      fromName: 'Jason Yu',
      fromAddress: 'jason@jyu.example',
      toAddress: 'dad@jyu.example',
      to: [{ name: 'Dad', address: 'dad@jyu.example' }],
      cc: [{ name: 'Mei', address: 'mei.yu@gmail.com' }],
      at: 2,
      body: ['These are great.'],
    },
  ],
};

const seed = (intent: string) => seedFor(request(intent), [DAD], ADDRESSES, ownedAddresses);

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
    const arrivedOn = ADDRESSES.find(i => i.address === 'jason@jyu.example');
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

/** A group thread: `to` and `cc` come off a real envelope. */
const GROUP: Thread = {
  id: 't-group',
  mailboxes: ['jason@jyu.example'],
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
      to: [{ address: 'jason@jyu.example' }, { name: 'Sam', address: 'sam@example.com' }],
      cc: [{ address: 'me@jyu.example' }, { address: 'kate@example.com' }],
      at: 1,
      body: ['See you Friday.'],
    },
  ],
};

const GROUP_OWNED = ['jason@jyu.example', 'me@jyu.example'];

/** A chain of Message-IDs. */
const CHAIN: Thread = {
  id: 't-chain',
  mailboxes: ['jason@jyu.example'],
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
    seedFor(request(`reply:${messageId}`), [CHAIN], ADDRESSES, GROUP_OWNED);

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
    expect(seedFor(request('reply:m-chain-1'), [repeated], ADDRESSES, GROUP_OWNED)).toMatchObject({
      references: ['<one@example.com>'],
    });
  });
});

describe('replyAllCc', () => {
  it('keeps the others and drops every address you own, plus the sender', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(replyAllCc(message, GROUP_OWNED)).toEqual(['sam@example.com']);
    // Case is not a difference between addresses, and To plus Cc naming one twice is one recipient.
    expect(
      replyAllCc(
        {
          ...message,
          to: [{ address: 'SAM@Example.com' }, { address: 'Jason@JYu.example' }],
          cc: [{ address: 'sam@example.com' }],
        },
        GROUP_OWNED,
      ),
    ).toEqual(['sam@example.com']);
  });

  it('is empty when the message was to you alone — the answer to whether to offer it', () => {
    const message = GROUP.messages[0];
    if (message === undefined) throw new Error('the group fixture lost its message');
    expect(
      replyAllCc({ ...message, to: [{ address: 'jason@jyu.example' }], cc: [] }, GROUP_OWNED),
    ).toEqual([]);
    // A draft carries no envelope to read recipients from.
    expect(replyAllCc({ ...message, to: undefined, cc: undefined }, GROUP_OWNED)).toEqual([]);
  });
});

describe('seedFor — reply all', () => {
  const seedGroup = (intent: string) => seedFor(request(intent), [GROUP], ADDRESSES, GROUP_OWNED);

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

describe('seedFor — Reply-To', () => {
  const [kate] = GROUP.messages;
  if (kate === undefined) throw new Error('the group fixture lost its message');
  const LIST: Thread = {
    ...GROUP,
    messages: [{ ...kate, replyTo: [{ address: 'friday@lists.example' }] }],
  };
  const seedList = (intent: string) => seedFor(request(intent), [LIST], ADDRESSES, GROUP_OWNED);

  it('replies where the sender asked, not to the sender', () => {
    expect(seedList('reply:m-group-1').to).toBe('friday@lists.example');
  });

  it('copies the rest on reply all, never the sender who asked to be answered elsewhere', () => {
    expect(seedList('reply-all:m-group-1').to).toBe('friday@lists.example');
    expect(seedList('reply-all:m-group-1').cc).toBe('sam@example.com');
  });

  it('never replies to yourself: a Reply-To naming your own address answers the sender', () => {
    // A list echoing your own post back: From the list, Reply-To you.
    const echo: Thread = {
      ...GROUP,
      messages: [
        {
          ...kate,
          fromName: 'Friday list',
          fromAddress: 'friday@lists.example',
          replyTo: [{ address: 'Jason@JYU.example' }],
        },
      ],
    };
    const seedEcho = (intent: string) => seedFor(request(intent), [echo], ADDRESSES, GROUP_OWNED);
    expect(seedEcho('reply:m-group-1').to).toBe('friday@lists.example');
    // Of a mixed Reply-To, only the others are answered.
    const mixed: Thread = {
      ...GROUP,
      messages: [
        { ...kate, replyTo: [{ address: 'me@jyu.example' }, { address: 'ops@example.com' }] },
      ],
    };
    expect(seedFor(request('reply:m-group-1'), [mixed], ADDRESSES, GROUP_OWNED).to).toBe(
      'ops@example.com',
    );
  });
});

/** A newsletter that arrived on the second address, offering a mailto: to leave its list. */
const NEWSLETTER: Thread = {
  id: 't-news',
  mailboxes: ['jason@northlane.example'],
  subject: 'Weekly picks',
  isUnread: true,
  isReplied: false,
  isStarred: false,
  messages: [
    {
      id: 'm-news-1',
      fromName: 'Picks',
      fromAddress: 'news@picks.example',
      toAddress: 'jason@northlane.example',
      to: [{ address: 'jason@northlane.example' }],
      at: 1,
      body: ['This week.'],
      unsubscribe: {
        https: 'https://picks.example/u/1',
        mailto: 'mailto:leave-1@picks.example?subject=Unsubscribe&body=Remove%20me.',
      },
    },
  ],
};

const unsubscribeSeed = (thread: Thread, messageId: string) =>
  seedFor({ kind: 'unsubscribe', messageId }, [thread], ADDRESSES, ownedAddresses);

describe('seedFor — unsubscribe', () => {
  it('writes to the mailto: address with its subject and body, quoting nothing', () => {
    expect(unsubscribeSeed(NEWSLETTER, 'm-news-1')).toEqual({
      identityId: 'jason@northlane.example',
      to: 'leave-1@picks.example',
      subject: 'Unsubscribe',
      body: 'Remove me.',
    });
  });

  it('is sent from the address the message was delivered to, not the first address', () => {
    // jyu is the first identity; the newsletter arrived on northlane.
    expect(unsubscribeSeed(NEWSLETTER, 'm-news-1').identityId).toBe('jason@northlane.example');
  });

  it('falls back to the first address as a reply does when the delivery address is not one of yours', () => {
    const [message] = NEWSLETTER.messages;
    if (message === undefined) throw new Error('fixture has no message');
    const bcc: Thread = {
      ...NEWSLETTER,
      messages: [{ ...message, toAddress: 'list@picks.example' }],
    };
    expect(unsubscribeSeed(bcc, 'm-news-1').identityId).toBe('jason@jyu.example');
    expect(
      seedFor({ kind: 'reply', messageId: 'm-news-1' }, [bcc], ADDRESSES, ownedAddresses)
        .identityId,
    ).toBe('jason@jyu.example');
  });

  it('is the message it is pressed on, not the thread’s newest arrival', () => {
    const [first] = NEWSLETTER.messages;
    if (first === undefined) throw new Error('fixture has no message');
    const later = {
      ...first,
      id: 'm-news-2',
      toAddress: 'jason@jyu.example',
      unsubscribe: { mailto: 'mailto:other@picks.example' },
    };
    const thread: Thread = { ...NEWSLETTER, messages: [first, later] };
    expect(unsubscribeSeed(thread, 'm-news-1')).toMatchObject({
      identityId: 'jason@northlane.example',
      to: 'leave-1@picks.example',
    });
    expect(unsubscribeSeed(thread, 'm-news-2')).toEqual({
      identityId: 'jason@jyu.example',
      to: 'other@picks.example',
    });
  });

  it('seeds nothing for a message with no mailto: offer, so no button can promise one', () => {
    const [message] = NEWSLETTER.messages;
    if (message === undefined) throw new Error('fixture has no message');
    for (const unsubscribe of [undefined, null, { https: 'https://picks.example/u/1' }]) {
      const thread: Thread = { ...NEWSLETTER, messages: [{ ...message, unsubscribe }] };
      expect(unsubscribeSeed(thread, 'm-news-1')).toEqual({});
    }
  });
});

describe('seedFor — degenerate requests', () => {
  it('degrades a stale message reference to a blank draft rather than erroring', () => {
    // Reachable only from a pasted or bookmarked URL.
    expect(seed('reply:m-does-not-exist')).toEqual({});
  });
});
