import type { AddressRecord, InboundAddress } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { connectImap, connectSmtp } from './connection';

/** What Connect runs before it stores a password: open, authenticate, close. */

export const testImap = async (
  imap: InboundAddress['imap'],
): Promise<Result<void, MailConnectionFailure>> => {
  const connRes = await connectImap(imap);
  if (!connRes.ok) return { ok: false, error: connRes.error };
  await connRes.value.close();
  return { ok: true, value: undefined };
};

export const testSmtp = async (
  smtp: AddressRecord['smtp'],
): Promise<Result<void, MailConnectionFailure>> => {
  const conn = await connectSmtp(smtp);
  if (!conn.ok) return conn;
  await conn.value.close();
  return { ok: true, value: undefined };
};
