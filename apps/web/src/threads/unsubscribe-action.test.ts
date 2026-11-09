import type { Message, ThreadState } from '@yozz.app/mail/threads/thread';
import { describe, expect, it } from 'vitest';
import { unsubscribeActionOf } from './unsubscribe-action';

const inInbox: Pick<ThreadState, 'folders'> = { folders: ['inbox'] };
const inJunk: Pick<ThreadState, 'folders'> = { folders: ['junk'] };

const BOTH = { https: 'https://news.example/u/7', mailto: 'mailto:leave@news.example' };

const action = (
  unsubscribe: Message['unsubscribe'],
  thread: Pick<ThreadState, 'folders'> = inInbox,
) => unsubscribeActionOf({ unsubscribe }, thread);

describe('unsubscribeActionOf', () => {
  it('opens the https: link when both forms are offered, being the fewest steps', () => {
    expect(action(BOTH)).toEqual({ kind: 'open-link', href: 'https://news.example/u/7' });
    expect(action({ https: BOTH.https })).toEqual({
      kind: 'open-link',
      href: 'https://news.example/u/7',
    });
  });

  it('writes a draft when only a mailto: is offered', () => {
    expect(action({ mailto: BOTH.mailto })).toEqual({ kind: 'write-draft' });
  });

  it('offers nothing for a message that offers nothing, or has not been read', () => {
    expect(action(null)).toBeNull();
    expect(action(undefined)).toBeNull();
    expect(action({})).toBeNull();
  });

  it('offers no draft from a mailto: the composer cannot start from', () => {
    expect(action({ mailto: 'mailto:' })).toBeNull();
  });

  it('is not offered in Junk, whichever form the sender offers', () => {
    expect(action(BOTH, inJunk)).toBeNull();
    expect(action({ mailto: BOTH.mailto }, inJunk)).toBeNull();
  });

  it('is still offered when only part of the conversation is in Junk', () => {
    expect(action(BOTH, { folders: ['junk', 'inbox'] })).not.toBeNull();
  });

  it('is not offered on a draft', () => {
    expect(unsubscribeActionOf({ unsubscribe: BOTH, isDraft: true }, inInbox)).toBeNull();
  });
});
