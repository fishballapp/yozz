import type { AddressRecord } from '@yozz.app/mail/addresses/record';
import type { MailConnectionFailure, Result } from '@yozz.app/mail/connection';
import { connectSmtp } from '../relay/connection';

/**
 * One SMTP connection, one submission of exactly these bytes. A failure says which side of the end
 * of `DATA` it fell on (`isUnconfirmedSubmission`), which the send machine needs to know.
 */
export const submitBytes = async (
  record: AddressRecord,
  bytes: Uint8Array,
  recipients: readonly string[],
): Promise<Result<void, MailConnectionFailure>> => {
  const conn = await connectSmtp(record.smtp);
  if (!conn.ok) return conn;
  const { client, close } = conn.value;
  try {
    const sent = await client.send({ from: record.address, to: recipients, data: bytes });
    if (!sent.ok) return { ok: false, error: { kind: 'smtp', reason: sent.reason } };
  } finally {
    await close();
  }
  return { ok: true, value: undefined };
};
