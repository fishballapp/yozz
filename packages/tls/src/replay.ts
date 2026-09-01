/** Test-only: injects RFC 8448's published ClientHellos and private keys. Not exported from index.ts. */

import { type HandshakeResult, runHandshake, type StartTlsOptions } from './handshake.ts';

export type ReplayHooks = {
  /** Published ClientHello message bytes, 1 or 2 long (CH2 after HRR). */
  readonly clientHelloMessages: readonly Uint8Array[];
  /** Matching private keys, same order (X25519 then P-256 for §5). */
  readonly clientEphemeralPrivateKeys: readonly Uint8Array[];
};

export const startTlsForReplay = (
  options: StartTlsOptions & { readonly replay: ReplayHooks },
): Promise<HandshakeResult> => runHandshake(options, options.replay);
