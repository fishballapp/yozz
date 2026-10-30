import { timingSafeEqual } from 'node:crypto';
import { formatCliToken } from '@yozz.app/vault-contract';

const TOKEN_SECRET_BYTES = 32;

const digest = async (token: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));

/** A plain SHA-256: the token is 256 random bits, so there is nothing for a slow hash to stretch. */
const hashCliToken = async (token: string): Promise<string> =>
  (await digest(token)).toBase64({ alphabet: 'base64url', omitPadding: true });

/** A new key's id and bearer, and the hash that is all the Worker keeps of it. */
export const mintCliToken = async (): Promise<{
  readonly keyId: string;
  readonly token: string;
  readonly tokenHash: string;
}> => {
  const keyId = crypto.randomUUID();
  const secret = crypto
    .getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES))
    .toBase64({ alphabet: 'base64url', omitPadding: true });
  const token = formatCliToken({ keyId, secret });
  return { keyId, token, tokenHash: await hashCliToken(token) };
};

export const isTokenOf = async (token: string, tokenHash: string): Promise<boolean> => {
  const stored = Uint8Array.fromBase64(tokenHash, { alphabet: 'base64url' });
  const presented = await digest(token);
  return stored.length === presented.length && timingSafeEqual(stored, presented);
};
