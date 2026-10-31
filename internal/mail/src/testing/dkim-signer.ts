/**
 * A DKIM signer for tests of the verifier. Its canonicalisation is written separately, over
 * strings and from the RFC's wording, so a test is not the verifier agreeing with itself.
 * ASCII messages with CRLF line ends only.
 */

export type TestAlgorithm = 'rsa-sha256' | 'rsa-sha1' | 'ed25519-sha256';

type Canonicalization = 'simple' | 'relaxed';

export type SignOptions = {
  readonly key: CryptoKey;
  readonly algorithm: TestAlgorithm;
  readonly domain: string;
  readonly selector: string;
  /** `h=`, in order. */
  readonly headers?: readonly string[];
  /** Header, then body. */
  readonly canonicalization?: readonly [Canonicalization, Canonicalization];
  /** Sign only the canonical body's first `bodyLength` bytes, stated as `l=`. */
  readonly bodyLength?: number;
  /** Extra tags, written before `bh=`, such as `i=@sub.example.com`. */
  readonly tags?: readonly string[];
};

const HASHES = {
  'rsa-sha256': 'SHA-256',
  'rsa-sha1': 'SHA-1',
  'ed25519-sha256': 'SHA-256',
} as const;

const simpleBody = (body: string) => body.replace(/(\r\n)*$/, '\r\n');

const relaxedBody = (body: string) => {
  const relaxed = body
    .replace(/[ \t]+(?=\r\n|$)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/(\r\n)*$/, '\r\n');
  return relaxed === '\r\n' ? '' : relaxed;
};

const simpleHeader = (field: string) => `${field}\r\n`;

const relaxedHeader = (field: string) => {
  const colon = field.indexOf(':');
  const value = field
    .slice(colon + 1)
    .replace(/\r\n/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${field.slice(0, colon).trim().toLowerCase()}:${value}\r\n`;
};

const CANONICAL = {
  simple: { header: simpleHeader, body: simpleBody },
  relaxed: { header: relaxedHeader, body: relaxedBody },
};

const ascii = (text: string) => new TextEncoder().encode(text);

const sign = async (key: CryptoKey, algorithm: TestAlgorithm, data: Uint8Array<ArrayBuffer>) => {
  if (algorithm === 'ed25519-sha256') {
    return crypto.subtle.sign(
      { name: 'Ed25519' },
      key,
      await crypto.subtle.digest('SHA-256', data),
    );
  }
  return crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, data);
};

/** The message with a `DKIM-Signature` field prepended. */
export const signMessage = async (
  message: string,
  {
    key,
    algorithm,
    domain,
    selector,
    headers = ['from', 'to', 'subject', 'date'],
    canonicalization: [headerCanonicalization, bodyCanonicalization] = ['relaxed', 'relaxed'],
    bodyLength,
    tags = [],
  }: SignOptions,
): Promise<string> => {
  const split = message.indexOf('\r\n\r\n');
  const head = split === -1 ? message : message.slice(0, split);
  const body = split === -1 ? '' : message.slice(split + 4);
  const canonicalBody = CANONICAL[bodyCanonicalization].body(body);
  const hashed = bodyLength === undefined ? canonicalBody : canonicalBody.slice(0, bodyLength);
  const bodyHash = new Uint8Array(
    await crypto.subtle.digest(HASHES[algorithm], ascii(hashed)),
  ).toBase64();
  const fields = head.split(/\r\n(?![ \t])/);
  const unpicked = [...fields];
  const picked = headers.flatMap(name => {
    const index = unpicked.findLastIndex(
      field => field.slice(0, field.indexOf(':')).trim().toLowerCase() === name,
    );
    return index === -1 ? [] : unpicked.splice(index, 1);
  });
  const signatureField = [
    `DKIM-Signature: v=1; a=${algorithm}; c=${headerCanonicalization}/${bodyCanonicalization}; d=${domain}; s=${selector};`,
    `\tt=1700000000; h=${headers.join(':')};${bodyLength === undefined ? '' : ` l=${bodyLength};`}`,
    ...tags.map(tag => `\t${tag};`),
    `\tbh=${bodyHash};`,
    '\tb=',
  ].join('\r\n');
  const canonicalHeader = CANONICAL[headerCanonicalization].header;
  const signed =
    picked.map(canonicalHeader).join('') + canonicalHeader(signatureField).slice(0, -2);
  const signature = new Uint8Array(await sign(key, algorithm, ascii(signed))).toBase64();
  // Folded inside the value, as real signers fold it; the verifier strips it with the rest.
  const folded = signature.replace(/.{1,64}/g, chunk => `${chunk}\r\n\t `).replace(/\r\n\t $/, '');
  return `${signatureField}${folded}\r\n${message}`;
};
