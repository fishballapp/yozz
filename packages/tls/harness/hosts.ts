/**
 * Stage 3's interop matrix — ARCHITECTURE.md#stage-3-result-passed — and M8's
 * denominator. Four IMAP implementations, so the matrix is not one stack tested
 * nine times.
 *
 * **One list, imported by both halves.** The Node driver and the browser driver
 * each claim to run "the same nine", and a copy in each is a claim nothing
 * enforces: edit one and the other keeps measuring a different matrix while the
 * docs still say they agree.
 *
 * `posteo.de` earns its place twice over. It refuses X25519 and P-256 outright,
 * so it is the only host here that takes a HelloRetryRequest and lands on
 * secp384r1 — which makes it the only one proving the P-384 offer is
 * load-bearing rather than decorative.
 *
 * `@yozz.app/x509`'s corpus harvests a superset of these (`corpus/harvest.ts`).
 * Different question, so a different list: that one wants many ISSUERS, this
 * one wants the servers we promised to interoperate with.
 */
export const HOSTS: readonly string[] = [
  'imap.gmail.com',
  'imap.fastmail.com',
  'imap.forwardemail.net',
  'mail.gandi.net',
  'disroot.org',
  'imap.mailbox.org',
  'mail.riseup.net',
  'imap.migadu.com',
  'posteo.de',
];

/** Implicit TLS. STARTTLS is deliberately unsupported — ARCHITECTURE.md. */
export const IMAP_PORT = 993;

/**
 * Whether a greeting is a server saying it is ready, rather than any bytes at
 * all.
 *
 * **M8 is defined as handshake AND greeting**, and only the greeting proves the
 * connection WORKS rather than merely completed: it is application data
 * decrypting under the negotiated keys, in the direction we never wrote in. So
 * the greeting has to be able to fail the gate, or a regression that completes
 * a handshake and then cannot decrypt the first record exits 0.
 *
 * RFC 9051 §7.1.1 gives three greetings, and only two of them mean the
 * connection is usable: `OK` and `PREAUTH`. `BYE` is the server refusing us —
 * which decrypts perfectly and must still count as a failed host.
 */
export const isReadyGreeting = (line: string): boolean =>
  line.startsWith('* OK') || line.startsWith('* PREAUTH');
