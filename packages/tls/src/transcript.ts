import { concat, writeUint8, writeUint24 } from './bytes.ts';
import { type CipherSuite, transcriptHash } from './key-schedule.ts';
import { HANDSHAKE_TYPES } from './wire.ts';

export class Transcript {
  private readonly suite: CipherSuite;
  private readonly messages: Uint8Array[] = [];
  private hasReplacedClientHello1 = false;

  constructor(suite: CipherSuite = 'TLS_AES_128_GCM_SHA256') {
    this.suite = suite;
  }

  add(message: Uint8Array): void {
    this.messages.push(message);
  }

  /** RFC 9846 §4.1: after a HelloRetryRequest, ClientHello1 becomes `message_hash || uint24(Hash.length) || Hash(ClientHello1)`. */
  async replaceClientHello1WithMessageHash(): Promise<void> {
    if (this.hasReplacedClientHello1) {
      throw new Error('replaceClientHello1WithMessageHash may be called only once');
    }
    if (this.messages.length === 0) {
      throw new Error('No ClientHello1 in transcript to replace');
    }
    const ch1 = this.messages[0];
    if (ch1 === undefined) {
      throw new Error('ClientHello1 is undefined');
    }
    const hash = await transcriptHash(this.suite, ch1);
    const messageHashMsg = concat(
      writeUint8(HANDSHAKE_TYPES.message_hash),
      writeUint24(hash.length),
      hash,
    );
    this.messages[0] = messageHashMsg;
    this.hasReplacedClientHello1 = true;
  }

  async hash(): Promise<Uint8Array> {
    return transcriptHash(this.suite, ...this.messages);
  }

  getMessages(): readonly Uint8Array[] {
    return [...this.messages];
  }
}
