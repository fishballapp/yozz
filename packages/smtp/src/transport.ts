export type ByteDuplex = {
  readonly read: () => Promise<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Promise<void>;
  /**
   * For a transport whose `write` can resolve with the bytes still on their way: settles once
   * everything written so far has gone, and rejects if it cannot have. Without it, a resolved `write`
   * is taken to mean the bytes have gone.
   */
  readonly flush?: () => Promise<void>;
};
