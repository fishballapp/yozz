/**
 * What this client needs from a transport: bytes in, bytes out. Declared here rather than
 * imported from `@yozz.app/tls` so the package has no runtime dependency at all; it is the same
 * two-method shape, so a `TlsConnection` satisfies it structurally.
 */
export type ByteDuplex = {
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
};
