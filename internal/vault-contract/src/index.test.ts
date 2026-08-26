import { describe, expect, it } from 'vitest';
import {
  BlindRecordIdSchema,
  FinalizePasswordUnlockRequestSchema,
  FinalizeUnlockRequestSchema,
  ListRecordsQuerySchema,
  ListRecordsResponseSchema,
  MAX_CIPHERTEXT_BYTES,
  PRF_INPUT_LABEL,
  PutRecordRequestSchema,
  RecordTypeSchema,
  UnlockStatusResponseSchema,
  VaultRecordEnvelopeSchema,
} from './index.ts';

describe('vault-contract invariants', () => {
  it('defines the versioned PRF input label', () => {
    expect(PRF_INPUT_LABEL).toBe('yozz-vault-prf-v1');
  });

  describe('PutRecordRequestSchema', () => {
    it('accepts valid ciphertext', () => {
      const valid = { ciphertext: 'aXYzMTIzNDU2' };
      expect(PutRecordRequestSchema.parse(valid)).toEqual(valid);
    });

    it('strictly rejects revision field', () => {
      const withRevision = { ciphertext: 'aXYzMTIzNDU2', revision: 1 };
      expect(() => PutRecordRequestSchema.parse(withRevision)).toThrow();
    });

    it('strictly rejects plaintext or secret fields', () => {
      expect(() =>
        PutRecordRequestSchema.parse({
          ciphertext: 'aXYzMTIzNDU2',
          plaintext: 'secret data',
        }),
      ).toThrow();
      expect(() =>
        PutRecordRequestSchema.parse({
          ciphertext: 'aXYzMTIzNDU2',
          naturalKey: 'account-1',
        }),
      ).toThrow();
      expect(() =>
        PutRecordRequestSchema.parse({
          ciphertext: 'aXYzMTIzNDU2',
          authValue: 'hunter2',
        }),
      ).toThrow();
      expect(() =>
        PutRecordRequestSchema.parse({
          ciphertext: 'aXYzMTIzNDU2',
          deviceSecret: 'abc',
        }),
      ).toThrow();
    });

    it('rejects oversized ciphertext', () => {
      const oversized = 'a'.repeat(MAX_CIPHERTEXT_BYTES + 1);
      expect(() => PutRecordRequestSchema.parse({ ciphertext: oversized })).toThrow();
    });
  });

  describe('VaultRecordEnvelopeSchema', () => {
    it('accepts valid envelope', () => {
      const envelope = {
        id: 'blind-id-123',
        type: 'account',
        ciphertext: 'Y2lwaGVydGV4dA==',
        updatedAt: 1700000000,
      };
      expect(VaultRecordEnvelopeSchema.parse(envelope)).toEqual(envelope);
    });

    it('strictly rejects revision field', () => {
      const envelopeWithRevision = {
        id: 'blind-id-123',
        type: 'account',
        ciphertext: 'Y2lwaGVydGV4dA==',
        updatedAt: 1700000000,
        revision: 4,
      };
      expect(() => VaultRecordEnvelopeSchema.parse(envelopeWithRevision)).toThrow();
    });

    it('strictly rejects naturalKey, deviceId, or plaintexts', () => {
      expect(() =>
        VaultRecordEnvelopeSchema.parse({
          id: 'blind-id-123',
          type: 'account',
          ciphertext: 'Y2lwaGVydGV4dA==',
          updatedAt: 1700000000,
          naturalKey: 'user@example.com',
        }),
      ).toThrow();
      expect(() =>
        VaultRecordEnvelopeSchema.parse({
          id: 'blind-id-123',
          type: 'account',
          ciphertext: 'Y2lwaGVydGV4dA==',
          updatedAt: 1700000000,
          deviceId: 'dev-123',
        }),
      ).toThrow();
    });
  });

  describe('BlindRecordIdSchema and RecordTypeSchema', () => {
    it('accepts valid base64url blind id', () => {
      expect(BlindRecordIdSchema.parse('abc-_123XYZ')).toBe('abc-_123XYZ');
    });

    it('rejects invalid blind id characters', () => {
      expect(() => BlindRecordIdSchema.parse('invalid id with spaces')).toThrow();
      expect(() => BlindRecordIdSchema.parse('invalid/slash')).toThrow();
      expect(() => BlindRecordIdSchema.parse('invalid+plus')).toThrow();
    });

    it('accepts valid record types', () => {
      expect(RecordTypeSchema.parse('account')).toBe('account');
      expect(RecordTypeSchema.parse('account:custom-1')).toBe('account:custom-1');
      expect(RecordTypeSchema.parse('auth_config')).toBe('auth_config');
    });

    it('rejects invalid record types', () => {
      expect(() => RecordTypeSchema.parse('Account')).toThrow();
      expect(() => RecordTypeSchema.parse('')).toThrow();
      expect(() => RecordTypeSchema.parse('type with spaces')).toThrow();
    });
  });

  describe('FinalizeUnlockRequestSchema', () => {
    const AUTH_VALUE = 'q0dGZ0Z0RGZnZGZnZGZnZGZnZGZnZGZnZGZnZGZnZGY=';

    it('parses password mode finalisation, which must carry authValue', () => {
      const payload = {
        mode: 'password',
        isNewVault: true,
        wrappedDek: 'd3JhcHBlZERlaw==',
        authValue: AUTH_VALUE,
      };
      expect(FinalizeUnlockRequestSchema.parse(payload)).toEqual(payload);
    });

    it('requires isNewVault to be stated, never defaulted', () => {
      // Defaulting it to false would make every create a silent upsert — the
      // race the flag exists to close. Defaulting to true would make every
      // rewrap a 409. So the client says which, every time.
      expect(() =>
        FinalizeUnlockRequestSchema.parse({
          mode: 'password',
          wrappedDek: 'd3JhcHBlZERlaw==',
          authValue: AUTH_VALUE,
        }),
      ).toThrow();
    });

    it('refuses password finalisation without authValue', () => {
      // Not a formality. Better Auth's `setPassword` is serverOnly, so the
      // Worker creates the credential inside this request — a finalisation
      // missing the authValue would set a mode whose credential never exists,
      // which is exactly the shape that shipped and had to be fixed.
      expect(() =>
        FinalizeUnlockRequestSchema.parse({ mode: 'password', wrappedDek: 'd3JhcHBlZERlaw==' }),
      ).toThrow();
    });

    it('refuses an authValue that is not base64 of 32 bytes', () => {
      for (const authValue of ['', 'not-base64!!', 'c2hvcnQ=']) {
        expect(() =>
          FinalizeUnlockRequestSchema.parse({
            mode: 'password',
            wrappedDek: 'd3JhcHBlZERlaw==',
            authValue,
          }),
        ).toThrow();
      }
    });

    it('parses passkey mode finalisation', () => {
      const payload = {
        mode: 'passkey',
        isNewVault: false,
        credentialId: 'pk-cred-123',
        wrappedDek: 'd3JhcHBlZERlaw==',
      };
      expect(FinalizeUnlockRequestSchema.parse(payload)).toEqual(payload);
    });

    it('strictly rejects password mode with credentialId or extra keys', () => {
      expect(() =>
        FinalizePasswordUnlockRequestSchema.parse({
          mode: 'password',
          wrappedDek: 'd3JhcHBlZERlaw==',
          credentialId: 'pk-123',
        }),
      ).toThrow();
    });

    it('strictly rejects revision or secrets in unlock finalisation', () => {
      expect(() =>
        FinalizeUnlockRequestSchema.parse({
          mode: 'password',
          wrappedDek: 'd3JhcHBlZERlaw==',
          revision: 1,
        }),
      ).toThrow();
      expect(() =>
        FinalizeUnlockRequestSchema.parse({
          mode: 'password',
          wrappedDek: 'd3JhcHBlZERlaw==',
          password: 'plain-password',
        }),
      ).toThrow();
    });
  });

  describe('UnlockStatusResponseSchema', () => {
    it('parses null mode status', () => {
      expect(UnlockStatusResponseSchema.parse({ mode: null })).toEqual({ mode: null });
    });

    it('parses password mode status', () => {
      const res = {
        mode: 'password',
        wrappedDek: 'd3JhcHBlZERlaw==',
        updatedAt: 1700000000,
      };
      expect(UnlockStatusResponseSchema.parse(res)).toEqual(res);
    });

    it('parses passkey mode status', () => {
      const res = {
        mode: 'passkey',
        passkeys: [{ passkeyId: 'pk-1', createdAt: 1700000000 }],
      };
      expect(UnlockStatusResponseSchema.parse(res)).toEqual(res);
    });

    it('strictly rejects unknown properties in status', () => {
      expect(() =>
        UnlockStatusResponseSchema.parse({
          mode: null,
          revision: 1,
        }),
      ).toThrow();
    });
  });

  describe('ListRecordsQuerySchema and ListRecordsResponseSchema', () => {
    it('parses valid list query', () => {
      expect(ListRecordsQuerySchema.parse({})).toEqual({});
      expect(ListRecordsQuerySchema.parse({ after: 'cursor-id' })).toEqual({
        after: 'cursor-id',
      });
    });

    it('strictly rejects relationship-leaking or search query parameters', () => {
      expect(() => ListRecordsQuerySchema.parse({ ids: ['id1', 'id2'] })).toThrow();
      expect(() => ListRecordsQuerySchema.parse({ q: 'search' })).toThrow();
      expect(() => ListRecordsQuerySchema.parse({ sort: 'updated_at' })).toThrow();
      expect(() => ListRecordsQuerySchema.parse({ filter: 'all' })).toThrow();
    });

    it('parses valid list response', () => {
      const res = {
        records: [
          {
            id: 'id-1',
            type: 'account',
            ciphertext: 'Y2lwaGVy',
            updatedAt: 1700000000,
          },
        ],
        nextCursor: 'id-1',
      };
      expect(ListRecordsResponseSchema.parse(res)).toEqual(res);
    });
  });
});
