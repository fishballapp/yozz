import { describe, expect, it } from 'vitest';
import { describeMailFailure } from './describe-failure.ts';

describe('describeMailFailure', () => {
  it('says what a secure connection failed with', () => {
    expect(describeMailFailure({ kind: 'tls', detail: 'ECONNRESET' }, 'imap.example.test')).toBe(
      'Secure connection to imap.example.test failed: ECONNRESET',
    );
  });

  it('still makes a sentence when the failure gave no detail', () => {
    expect(describeMailFailure({ kind: 'tls', detail: '' }, 'imap.example.test')).toBe(
      'Secure connection to imap.example.test failed: the connection dropped',
    );
  });
});
