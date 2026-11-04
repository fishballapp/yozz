import { describe, expect, it } from 'vitest';
import { previewKey, withBodies, withoutMailboxPreviews } from './body-state.ts';
import type { Message, ThreadState } from './thread.ts';

const message = (over: Partial<Message>): Message => ({
  id: 'mid/<a@x>',
  fromName: 'A',
  fromAddress: 'a@x',
  toAddress: 'me@x',
  at: 1,
  body: [],
  bodyStatus: 'pending',
  locations: [{ mailbox: 'me@x', folder: 'inbox', uidValidity: 1, uid: 7 }],
  ...over,
});

const thread = (messages: Message[]): ThreadState => ({
  id: 't',
  mailboxes: ['me@x'],
  subject: 's',
  messages,
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders: ['inbox'],
  foldersByMailbox: { 'me@x': ['inbox'] },
});

describe('withBodies', () => {
  const previews = {
    [previewKey({ mailbox: 'me@x', folder: 'inbox', uidValidity: 1, uid: 7 })]: ['cached text'],
  };

  it('fills an unopened message from the preview and keeps it pending', () => {
    const [out] = withBodies([thread([message({})])], {}, previews);
    expect(out?.messages[0]).toMatchObject({ body: ['cached text'], bodyStatus: 'pending' });
  });

  it('keeps the preview under a loading or failed entry', () => {
    const [out] = withBodies(
      [thread([message({})])],
      { 'mid/<a@x>': { status: 'failed' } },
      previews,
    );
    expect(out?.messages[0]).toMatchObject({ body: ['cached text'], bodyStatus: 'failed' });
  });

  it('a loaded body wins over the preview', () => {
    const [out] = withBodies(
      [thread([message({})])],
      {
        'mid/<a@x>': {
          status: 'loaded',
          body: ['full'],
          hasTextPart: true,
          inlineImagesTruncated: false,
          attachments: [],
        },
      },
      previews,
    );
    expect(out?.messages[0]).toMatchObject({ body: ['full'], bodyStatus: undefined });
  });

  it('a reused uid under a new uidValidity gets nothing', () => {
    const reset = message({
      locations: [{ mailbox: 'me@x', folder: 'inbox', uidValidity: 2, uid: 7 }],
    });
    const [out] = withBodies([thread([reset])], {}, previews);
    expect(out?.messages[0]?.body).toEqual([]);
  });

  it('leaves a vault-held message alone', () => {
    const held = message({ body: ['mine'], bodyStatus: undefined });
    const [out] = withBodies([thread([held])], {}, previews);
    expect(out?.messages[0]?.body).toEqual(['mine']);
  });

  it('drops one mailbox without touching another', () => {
    const both = { ...previews, 'you@x/inbox/1/1': ['other'] };
    expect(withoutMailboxPreviews(both, 'me@x')).toEqual({ 'you@x/inbox/1/1': ['other'] });
  });
});
