/**
 * Shared so the limbo harness, the decoder's own gates and the shipped trust
 * store's build step read PEM the same way. One regex, because a second copy is
 * a place for the two to drift — and one decides what "green" means while
 * another decides which roots ship.
 *
 * The write direction lives here for the same reason, and did not always: it was
 * a private four-liner in `openssl.ts` until a second copy appeared in the
 * trust-store diff's tests, which is the drift this module's first paragraph is
 * about. `@yozz.app/tls` has its own reader and keeps it — that package may not
 * import from this one's harness, and a shared PEM helper is not worth crossing
 * the boundary [ARCHITECTURE.md] draws.
 */
export const derFromPem = (pem: string): Uint8Array[] =>
  [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    match => new Uint8Array(Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64')),
  );

/** DER to PEM, 64 characters to a line as RFC 7468 §2 asks. */
export const pemFromDer = (der: Uint8Array): string => {
  const base64 = Buffer.from(der).toString('base64');
  return `-----BEGIN CERTIFICATE-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;
};
