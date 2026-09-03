/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { addressRecordSchema, isInbound, markOf, parseAddressRecord } from './record';

const inbound = {
  address: 'jason@jyu.example',
  senderName: 'Jason Yu',
  smtp: {
    host: 'smtp.fastmail.com',
    port: 465,
    username: 'jason@jyu.example',
    password: 'demo-app-password',
  },
  imap: {
    host: 'imap.fastmail.com',
    port: 993,
    username: 'jason@jyu.example',
    password: 'demo-app-password',
  },
};

const sendOnly = {
  address: 'billing@northlane.example',
  smtp: {
    host: 'smtp.fastmail.com',
    port: 465,
    username: 'billing@northlane.example',
    password: 'demo-app-password',
  },
};

describe('addressRecordSchema', () => {
  it('accepts an inbound and a send-only record', () => {
    expect(addressRecordSchema.safeParse(inbound).success).toBe(true);
    expect(addressRecordSchema.safeParse(sendOnly).success).toBe(true);
  });

  it('rejects a bad port, a missing smtp, and a non-email address', () => {
    expect(
      addressRecordSchema.safeParse({
        ...inbound,
        smtp: { ...inbound.smtp, port: 0 },
      }).success,
    ).toBe(false);
    expect(
      addressRecordSchema.safeParse({
        address: inbound.address,
        imap: inbound.imap,
      }).success,
    ).toBe(false);
    expect(
      addressRecordSchema.safeParse({
        ...inbound,
        address: 'not-an-email',
      }).success,
    ).toBe(false);
  });
});

describe('parseAddressRecord', () => {
  it('returns null for non-JSON and for a wrong shape', () => {
    expect(parseAddressRecord('not json')).toBeNull();
    expect(parseAddressRecord(JSON.stringify({ address: 'x' }))).toBeNull();
  });

  it('parses a valid record', () => {
    expect(parseAddressRecord(JSON.stringify(sendOnly))).toEqual(sendOnly);
  });
});

describe('markOf', () => {
  it('takes the first character of the local part', () => {
    expect(markOf('jason@x.y')).toBe('J');
    expect(markOf('@x')).toBe('?');
  });
});

describe('isInbound', () => {
  it('narrows to records with imap', () => {
    const parsedInbound = addressRecordSchema.parse(inbound);
    const parsedSendOnly = addressRecordSchema.parse(sendOnly);
    expect(isInbound(parsedInbound)).toBe(true);
    expect(isInbound(parsedSendOnly)).toBe(false);
    if (isInbound(parsedInbound)) {
      expect(parsedInbound.imap.host).toBe('imap.fastmail.com');
    }
  });
});
