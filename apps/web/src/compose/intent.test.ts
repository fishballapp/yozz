import type { ComposeDraft } from '@yozz.app/mail/compose/draft';
import { describe, expect, it } from 'vitest';
import { composeIntentSchema, isUntouched, seedRequestOf } from './intent';

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

  it('names nothing for a new message or an existing draft, which open blank or as stored', () => {
    expect(seedRequestOf('new')).toBeNull();
    expect(seedRequestOf('draft:k-1')).toBeNull();
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
