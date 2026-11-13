import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import type { Thread } from '@yozz.app/mail/threads/thread';
import { describe, expect, it } from 'vitest';
import { composeIntentSchema, composeTitleOf, isUntouched, seedRequestOf } from './intent';

describe('seedRequestOf', () => {
  it('names the message a reply, a reply all or a forward answers', () => {
    expect(seedRequestOf('reply:m-1')).toEqual({ kind: 'reply', messageId: 'm-1' });
    expect(seedRequestOf('reply-all:m-1')).toEqual({ kind: 'reply-all', messageId: 'm-1' });
    // A message id may carry colons of its own.
    expect(seedRequestOf('forward:mid/<a:b@x>')).toEqual({
      kind: 'forward',
      messageId: 'mid/<a:b@x>',
    });
  });

  it('names the message whose mailto: an unsubscribe writes to', () => {
    expect(seedRequestOf('unsubscribe:mid/<a:b@x>')).toEqual({
      kind: 'unsubscribe',
      messageId: 'mid/<a:b@x>',
    });
  });

  it('names nothing for a new message or an existing draft, which open blank or as stored', () => {
    expect(seedRequestOf('new')).toBeNull();
    expect(seedRequestOf('draft:k-1')).toBeNull();
  });
});

describe('composeIntentSchema', () => {
  it('accepts the six shapes and rejects everything else', () => {
    for (const ok of [
      'new',
      'reply:m-1',
      'reply-all:m-1',
      'forward:m-1',
      'unsubscribe:m-1',
      'draft:k-1',
    ]) {
      expect(composeIntentSchema.safeParse(ok).success).toBe(true);
    }
    // A junk `?compose=` reads as closed.
    for (const bad of [
      'reply:',
      'reply-all:',
      'forward:',
      'unsubscribe:',
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

  it('is true for a forward nobody touched, its files uploading or not', () => {
    const file = { id: 'file-1', name: 'f.pdf', size: 3, kind: 'pdf' as const };
    const forward = { ...opened, attachments: [{ ...file, upload: 'uploading' as const }] };
    expect(
      isUntouched({ ...forward, attachments: [{ ...file, upload: 'uploaded' }] }, forward),
    ).toBe(true);
    expect(isUntouched({ ...forward, attachments: [] }, forward)).toBe(false);
  });

  it('is false for an attachment alone, which is writing with no text in it', () => {
    const attached = {
      ...opened,
      attachments: [
        { id: 'file-1', name: 'f.pdf', size: 3, kind: 'pdf' as const, upload: 'uploaded' as const },
      ],
    };
    expect(isUntouched(attached, opened)).toBe(false);
  });
});

describe('composeTitleOf', () => {
  const message = (id: string, fromName: string, fromAddress: string, toAddress: string) => ({
    id,
    fromName,
    fromAddress,
    toAddress,
    at: 0,
    body: [],
    locations: [],
  });
  const thread = (messages: Thread['messages']): Thread => ({
    id: 't',
    mailboxes: ['me@x.test'],
    subject: 'Sunday',
    isUnread: false,
    isReplied: false,
    isStarred: false,
    messages,
  });
  const fromDad = thread([
    message('m-1', 'Dad', 'dad@family.example', 'me@x.test'),
    message('m-2', 'Me', 'me@x.test', 'dad@family.example'),
  ]);
  const owned = ['me@x.test'];

  it('names who a reply goes to, whichever message was pressed', () => {
    expect(composeTitleOf('reply:m-1', [fromDad], owned)).toBe('Reply to Dad');
    expect(composeTitleOf('reply:m-2', [fromDad], owned)).toBe('Reply to Dad');
  });

  it('names nobody when the thread is all your own mail, or has not loaded', () => {
    const mine = thread([message('m-9', 'Me', 'me@x.test', 'dad@family.example')]);
    expect(composeTitleOf('reply:m-9', [mine], owned)).toBe('Reply');
    expect(composeTitleOf('reply:m-1', [], owned)).toBe('Reply');
  });

  it('says what the other intents are', () => {
    expect(composeTitleOf('reply-all:m-1', [fromDad], owned)).toBe('Reply all');
    expect(composeTitleOf('forward:m-1', [fromDad], owned)).toBe('Forward');
    expect(composeTitleOf('new', [fromDad], owned)).toBe('New message');
    expect(composeTitleOf('unsubscribe:m-1', [fromDad], owned)).toBe('New message');
    expect(composeTitleOf('draft:k-1', [fromDad], owned)).toBe('New message');
  });
});
