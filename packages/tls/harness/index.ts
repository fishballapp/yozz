/**
 * The pieces of this harness other packages' live harnesses reuse, so there is one host list
 * and one node:net transport rather than a copy per package. Not part of `@yozz.app/tls` proper.
 */
export { HOSTS, IMAP_PORT, isReadyGreeting } from './hosts.ts';
export { endGracefully, socketTransport } from './socket-transport.ts';
