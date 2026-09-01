/**
 * Stage 3's interop matrix (ARCHITECTURE.md#stage-3-result-passed): four IMAP implementations.
 * One list for the Node and browser drivers. `posteo.de` refuses X25519 and P-256, so it is the
 * only host that takes a HelloRetryRequest and proves the P-384 offer. `@yozz.app/x509`'s
 * corpus harvest wants many issuers instead, so it keeps its own list.
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

/** Implicit TLS; STARTTLS is unsupported (ARCHITECTURE.md). */
export const IMAP_PORT = 993;

/** RFC 9051 §7.1.1: `OK` and `PREAUTH` mean usable; `BYE` decrypts perfectly and still means refused. */
export const isReadyGreeting = (line: string): boolean =>
  line.startsWith('* OK') || line.startsWith('* PREAUTH');
