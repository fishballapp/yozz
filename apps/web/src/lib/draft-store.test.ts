import { describe, expect, it } from 'vitest';
import type { ComposeDraft } from '../state/mail';
import { clearDraft, loadDraft, saveDraft } from './draft-store';

const draft: ComposeDraft = {
  startedAsReply: true,
  identityId: 'me@x',
  to: 'a@x',
  cc: '',
  bcc: '',
  subject: 'Re: hi',
  body: 'typed so far',
  inReplyTo: '<1@x>',
  attachments: [{ name: 'f.pdf', size: 3, kind: 'pdf', content: new Uint8Array([1, 2, 3]) }],
};

/** Enough of `Storage` for the store: what a browser gives it, over a Map. */
const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: index => [...map.keys()][index] ?? null,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    clear: () => map.clear(),
  };
};

describe('draft store', () => {
  it('restores the draft for the same intent, without the attachment bytes', () => {
    const storage = memoryStorage();
    saveDraft('u1', 'reply:me@x/inbox/1', draft, storage);
    expect(loadDraft('u1', 'reply:me@x/inbox/1', storage)).toEqual({ ...draft, attachments: [] });
  });

  it('drops a record that does not parse instead of throwing', () => {
    const storage = memoryStorage();
    storage.setItem('yozz:draft:u1', '{not json');
    expect(loadDraft('u1', 'new', storage)).toBeNull();
    expect(storage.getItem('yozz:draft:u1')).toBeNull();
  });

  it('gives nothing for another intent, another user, or after a clear', () => {
    const storage = memoryStorage();
    saveDraft('u1', 'reply:me@x/inbox/1', draft, storage);
    expect(loadDraft('u1', 'new', storage)).toBeNull();
    expect(loadDraft('u2', 'reply:me@x/inbox/1', storage)).toBeNull();
    clearDraft('u1', storage);
    expect(loadDraft('u1', 'reply:me@x/inbox/1', storage)).toBeNull();
  });
});
