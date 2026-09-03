import { describe, expect, it } from 'vitest';
import { isArchived, isTrashed } from './thread';

describe('isArchived', () => {
  it('is a thread with archive mail and nothing left in the inbox', () => {
    expect(isArchived({ folders: ['archive'] })).toBe(true);
    expect(isArchived({ folders: ['sent', 'archive'] })).toBe(true);
    // A reply that landed after the archive brings the conversation back, as in Gmail.
    expect(isArchived({ folders: ['inbox', 'archive'] })).toBe(false);
    expect(isArchived({ folders: ['inbox', 'sent'] })).toBe(false);
  });
});

describe('isTrashed', () => {
  it('is a thread whose every message sits in the bin', () => {
    expect(isTrashed({ folders: ['trash'] })).toBe(true);
    // Half of it deleted is not deleted: the rest is still live mail.
    expect(isTrashed({ folders: ['inbox', 'trash'] })).toBe(false);
    expect(isTrashed({ folders: ['sent', 'trash'] })).toBe(false);
    expect(isTrashed({ folders: [] })).toBe(false);
  });
});
