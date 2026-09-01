/** One PEM reader for the limbo harness, the decoder gates and the trust-store build, so they cannot drift. */
export const derFromPem = (pem: string): Uint8Array[] =>
  [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    match => new Uint8Array(Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64')),
  );

/** DER to PEM, 64 characters to a line as RFC 7468 §2 asks. */
export const pemFromDer = (der: Uint8Array): string => {
  const base64 = Buffer.from(der).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
};
