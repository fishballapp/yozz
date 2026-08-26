import { z } from 'zod';

const hostSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  password: z.string().min(1),
});

/** The plaintext of an `address` vault record. The natural key is `address`. */
export const addressRecordSchema = z.object({
  address: z.string().email(),
  /**
   * The display name recipients see on mail sent from this address (`Jason Yu <jason@…>`). It
   * is part of the outgoing From header and nothing else: inside YOZZ an address is always shown
   * as itself (DECISIONS.md).
   */
  senderName: z.string().optional(),
  smtp: hostSchema,
  /** Absent means send-only: an address with no inbox here. The normal case, not an error. */
  imap: hostSchema.optional(),
});
export type AddressRecord = z.infer<typeof addressRecordSchema>;

export const ADDRESS_RECORD_TYPE = 'address';

/** Total: a record this build cannot read is skipped, never thrown on, and logged by the caller. */
export const parseAddressRecord = (plaintext: string): AddressRecord | null => {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    const result = addressRecordSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export type InboundAddress = AddressRecord & { imap: NonNullable<AddressRecord['imap']> };

export const isInbound = (record: AddressRecord): record is InboundAddress =>
  record.imap !== undefined;

/** The gutter letter: first character of the local part, upper-cased. `?` for an empty local part. */
export const markOf = (address: string): string => {
  const local = address.slice(0, address.indexOf('@'));
  const first = local[0];
  return first === undefined ? '?' : first.toUpperCase();
};
