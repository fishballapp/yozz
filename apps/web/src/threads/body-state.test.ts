import { describe, expect, it } from 'vitest';
import { previewKey, withBodies, withoutAccountPreviews } from './body-state';
import type { Message, ThreadState } from './thread';

const message = (over: Partial<Message>): Message => ({
  id: 'mid/<a@x>',
  fromName: 'A',
  fromAddress: 'a@x',
  toAddress: 'me@x',
  at: 1,
  body: [],
  bodyStatus: 'pending',
  locations: [{ account: 'me@x', folder: 'inbox', uidValidity: 1, uid: 7 }],
  ...over,
});

const thread = (messages: Message[]): ThreadState => ({
  id: 't',
  accounts: ['me@x'],
  subject: 's',
  messages,
  isUnread: false,
  isReplied: false,
  isStarred: false,
  folders: ['inbox'],
  foldersByAccount: { 'me@x': ['inbox'] },
});

describe('withBodies', () => {
  const previews = {
    [previewKey({ account: 'me@x', folder: 'inbox', uidValidity: 1, uid: 7 })]: ['cached text'],
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
      locations: [{ account: 'me@x', folder: 'inbox', uidValidity: 2, uid: 7 }],
    });
    const [out] = withBodies([thread([reset])], {}, previews);
    expect(out?.messages[0]?.body).toEqual([]);
  });

  it('leaves a vault-held message alone', () => {
    const held = message({ body: ['mine'], bodyStatus: undefined });
    const [out] = withBodies([thread([held])], {}, previews);
    expect(out?.messages[0]?.body).toEqual(['mine']);
  });

  it('drops one account without touching another', () => {
    const both = { ...previews, 'you@x/inbox/1/1': ['other'] };
    expect(withoutAccountPreviews(both, 'me@x')).toEqual({ 'you@x/inbox/1/1': ['other'] });
  });
});
