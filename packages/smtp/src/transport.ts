export type ByteDuplex = {
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
};
