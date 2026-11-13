import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import { describe, expect, it } from 'vitest';
import { hostsOf } from './Settings';

const record = (imap: string | null, smtp: string) =>
  ({
    address: 'a@example.com',
    smtp: { host: smtp },
    ...(imap === null ? {} : { imap: { host: imap } }),
  }) as AddressRecord;

describe('hostsOf', () => {
  it('prints a pair under one domain once', () => {
    expect(hostsOf(record('imap.fastmail.com', 'smtp.fastmail.com'))).toEqual(['fastmail.com']);
    expect(hostsOf(record('mail.example.com', 'mail.example.com'))).toEqual(['mail.example.com']);
  });

  it('puts any other pair on two lines', () => {
    expect(hostsOf(record('outlook.office365.com', 'smtp.gmail.com'))).toEqual([
      'outlook.office365.com',
      'smtp.gmail.com',
    ]);
  });

  it('prints a send-only address’s one host', () => {
    expect(hostsOf(record(null, 'smtp.example.com'))).toEqual(['smtp.example.com']);
  });
});
