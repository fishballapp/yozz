import type { PeerName } from '@yozz.app/x509';
import { type Alert, decodeAlert, encodeAlert, type TlsFailure } from '../alert.ts';
import {
  decodeHandshakeMessage,
  decodeTls12HandshakeMessage,
  encodeHandshakeMessage,
} from '../handshake-messages.ts';
import {
  CIPHER_SUITES,
  type CipherSuite,
  exportKeyingMaterial,
  hkdfExpandLabel,
  trafficKeys,
} from '../key-schedule.ts';
import {
  MAX_RECORD_PLAINTEXT,
  openAead,
  openTls12Aead,
  sealAead,
  sealTls12Aead,
} from '../record.ts';
import { type PeerCertificateChain, sessionFromTicket, type TlsSession } from '../session.ts';
import { type Tls12KeyBlock, tls12ExportKeyingMaterial } from '../tls12-key-schedule.ts';
import { HANDSHAKE_TYPES, type SignatureScheme, type Tls12CipherSuite } from '../wire.ts';
import {
  createAeadSealer,
  createTls12AeadSealer,
  type HandshakePeer,
  MAX_WARNING_ALERTS,
} from './peer.ts';

export type TlsConnection = {
  readonly read: () => Promise<TlsReadResult>;
  readonly write: (plaintext: Uint8Array) => Promise<TlsWriteResult>;
  readonly close: () => Promise<TlsCloseResult>;
  /**
   * RFC 9846 §7.5 (TLS 1.3) or RFC 5705 (TLS 1.2), for channel binding (RFC 9266 `tls-exporter`).
   * On TLS 1.3, `null` is treated as an empty context and `label` may not be empty (`HkdfLabel.label`
   * is `opaque<7..255>`). On TLS 1.2, `null` omits the context length prefix and Extended Master
   * Secret (RFC 7627 §5.4) is required.
   */
  readonly exportKeyingMaterial: (
    label: string,
    context: Uint8Array | null,
    length: number,
  ) => Promise<Uint8Array>;
};

export type TlsReadResult =
  | { readonly ok: true; readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly ok: true; readonly kind: 'closed' }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TlsFailure };

export type TlsCloseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: TlsFailure };

/**
 * TLS 1.3 bounds none of these; the numbers are BoringSSL's, which BoGo pins from both sides. They
 * count CONSECUTIVE occurrences and reset on delivered application data, so a long IMAP session
 * survives its 33rd rekey.
 */
const MAX_CONSECUTIVE_EMPTY_RECORDS = 32;
const MAX_KEY_UPDATES = 32;
/** BoGo pins none; each ticket costs an HKDF expansion and a call into the caller's store. Real servers send two. */
const MAX_CONSECUTIVE_SESSION_TICKETS = 32;
/** AES-GCM record limit before closing (TLS 1.2 has no KeyUpdate). */
const MAX_AES_GCM_RECORDS = 2n ** 24n;

const createWriteQueue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action, action);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
};

export const createTls13Connection = async ({
  peer,
  suite,
  clientAppTrafficSecret,
  serverAppTrafficSecret,
  exporterMaster,
  resumptionSecret,
  authenticatedAt,
  peerSignatureScheme,
  peerCertificateChain,
  serverName,
  expectedPeerName,
  onSession,
  now,
}: {
  readonly peer: HandshakePeer;
  readonly suite: CipherSuite;
  readonly clientAppTrafficSecret: Uint8Array;
  readonly serverAppTrafficSecret: Uint8Array;
  readonly exporterMaster: Uint8Array;
  readonly resumptionSecret: Uint8Array;
  readonly authenticatedAt: Temporal.Instant;
  readonly peerSignatureScheme: SignatureScheme;
  readonly peerCertificateChain: PeerCertificateChain;
  readonly serverName: string;
  readonly expectedPeerName: PeerName | null;
  readonly onSession?: (session: TlsSession) => void | Promise<void>;
  readonly now: () => Temporal.Instant;
}): Promise<TlsConnection> => {
  let clientTrafficSecret = clientAppTrafficSecret;
  let serverTrafficSecret = serverAppTrafficSecret;
  let clientAppKeys = await trafficKeys(suite, clientTrafficSecret);
  let serverAppKeys = await trafficKeys(suite, serverTrafficSecret);
  let clientAppSeq = 0n;
  let serverAppSeq = 0n;
  // RFC 9846 §6.1: each direction closes on its own.
  let peerSentCloseNotify = false;
  let sentCloseNotify = false;
  let terminalFailure: TlsFailure | null = null;

  peer.setRecordSealer(
    createAeadSealer(
      () => ({ key: clientAppKeys.key, iv: clientAppKeys.iv, seq: clientAppSeq }),
      () => {
        clientAppSeq += 1n;
      },
    ),
  );

  const queueWrite = createWriteQueue();

  const failWith = (reason: TlsFailure): { readonly ok: false; readonly reason: TlsFailure } => {
    terminalFailure ??= reason;
    return { ok: false, reason };
  };

  // Through the write queue, or one AES-GCM (key, nonce) can come to cover two plaintexts.
  const abortWith = async (
    description: Alert['description'],
  ): Promise<{ readonly ok: false; readonly reason: TlsFailure }> => {
    const reason: TlsFailure = { kind: 'alert-sent', alert: { level: 'fatal', description } };
    terminalFailure ??= reason;
    await queueWrite(async () => {
      await peer.sendFatalAlert(description);
    });
    return { ok: false, reason };
  };

  let emptyPostHandshakeRecords = 0;
  let warningAlertsSeen = 0;
  let keyUpdatesSeen = 0;
  let sessionTicketsSeen = 0;

  // RFC 9846 §4.7.3 requires a response but sets no deadline: several requests are answered once,
  // on the next write, inside the write queue.
  let keyUpdateResponseOwed = false;

  const payKeyUpdateResponse = async (): Promise<void> => {
    if (!keyUpdateResponseOwed) return;
    keyUpdateResponseOwed = false;

    const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });
    const sealedKu = await sealAead(
      clientAppKeys.key,
      clientAppKeys.iv,
      clientAppSeq,
      'handshake',
      kuMsg,
    );
    clientAppSeq += 1n;
    await peer.transport.write(sealedKu);

    clientTrafficSecret = await hkdfExpandLabel(
      suite,
      clientTrafficSecret,
      'traffic upd',
      new Uint8Array(0),
      CIPHER_SUITES[suite].hashLength,
    );
    clientAppKeys = await trafficKeys(suite, clientTrafficSecret);
    clientAppSeq = 0n;
  };

  return {
    read: async (): Promise<TlsReadResult> => {
      while (true) {
        if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
        if (peerSentCloseNotify) return { ok: true, kind: 'closed' };
        let extracted = peer.extractNextHandshakeMessage();
        if (extracted.kind === 'message') {
          // Leftover handshake bytes from a prior coalesced record.
        } else if (extracted.kind === 'overflow') {
          return abortWith('decode_error');
        } else {
          const recResult = await peer.reader.readRecord();
          if (!recResult.ok) {
            if (recResult.kind === 'truncated') {
              return failWith({ kind: 'truncated' });
            }
            return abortWith(recResult.description);
          }

          if (recResult.kind === 'eof') {
            return failWith({ kind: 'truncated' });
          }

          const record = recResult.record;
          // RFC 9846 §5: a ChangeCipherSpec is tolerated only until the peer's Finished.
          if (record[0] !== 0x17) {
            return abortWith('unexpected_message');
          }

          const openRes = await openAead(serverAppKeys.key, serverAppKeys.iv, serverAppSeq, record);
          serverAppSeq += 1n;

          if (!openRes.ok) {
            return abortWith(openRes.description);
          }

          if (openRes.type === 'application_data') {
            // §5.4: zero-length records are a traffic-analysis countermeasure, not data.
            if (openRes.payload.length === 0) {
              emptyPostHandshakeRecords += 1;
              if (emptyPostHandshakeRecords > MAX_CONSECUTIVE_EMPTY_RECORDS) {
                return abortWith('unexpected_message');
              }
              continue;
            }
            // Delivered data clears every ceiling.
            emptyPostHandshakeRecords = 0;
            warningAlertsSeen = 0;
            keyUpdatesSeen = 0;
            sessionTicketsSeen = 0;
            return { ok: true, kind: 'data', bytes: openRes.payload };
          }

          if (openRes.type === 'alert') {
            const alertRes = decodeAlert(openRes.payload);
            if (!alertRes.ok) {
              if (alertRes.unknownDescriptionCode !== undefined) {
                return failWith({
                  kind: 'alert-received-unknown',
                  code: alertRes.unknownDescriptionCode,
                });
              }
              return abortWith(alertRes.description);
            }
            if (alertRes.alert.description === 'close_notify') {
              peerSentCloseNotify = true;
              return { ok: true, kind: 'closed' };
            }
            // §6.1: `user_canceled` is ignored, but counted.
            if (alertRes.alert.description === 'user_canceled') {
              warningAlertsSeen += 1;
              if (warningAlertsSeen > MAX_WARNING_ALERTS) {
                return abortWith('unexpected_message');
              }
              continue;
            }
            return failWith({ kind: 'alert-received', alert: alertRes.alert });
          }

          if (openRes.type !== 'handshake') {
            return abortWith('unexpected_message');
          }

          peer.pushHandshakeBytes(openRes.payload);
          extracted = peer.extractNextHandshakeMessage();
          while (extracted.kind === 'need-more') {
            const more = await peer.reader.readRecord();
            if (!more.ok) {
              if (more.kind === 'truncated') {
                return failWith({ kind: 'truncated' });
              }
              return abortWith(more.description);
            }
            if (more.kind === 'eof') {
              return failWith({ kind: 'truncated' });
            }
            if (more.record[0] !== 0x17) {
              return abortWith('unexpected_message');
            }
            const moreOpen = await openAead(
              serverAppKeys.key,
              serverAppKeys.iv,
              serverAppSeq,
              more.record,
            );
            serverAppSeq += 1n;
            if (!moreOpen.ok) {
              return abortWith(moreOpen.description);
            }
            if (moreOpen.type !== 'handshake') {
              // A non-handshake record mid-fragment.
              return abortWith('unexpected_message');
            }
            peer.pushHandshakeBytes(moreOpen.payload);
            extracted = peer.extractNextHandshakeMessage();
          }
          if (extracted.kind === 'overflow') {
            return abortWith('decode_error');
          }
        }

        if (extracted.kind !== 'message') {
          continue;
        }

        const decoded = decodeHandshakeMessage(extracted.bytes);
        if (!decoded.ok) {
          return abortWith(decoded.description);
        }

        if (decoded.value.kind === 'new_session_ticket') {
          sessionTicketsSeen += 1;
          if (sessionTicketsSeen > MAX_CONSECUTIVE_SESSION_TICKETS) {
            return abortWith('unexpected_message');
          }
          if (onSession !== undefined) {
            const session = await sessionFromTicket({
              serverName,
              expectedPeerName,
              suite,
              resumptionSecret,
              receivedAt: now(),
              authenticatedAt,
              peerSignatureScheme,
              peerCertificateChain,
              ticket: decoded.value.ticket,
              ticketNonce: decoded.value.ticketNonce,
              ticketAgeAdd: decoded.value.ticketAgeAdd,
              ticketLifetime: decoded.value.ticketLifetime,
            });
            // The caller's store is not on the critical path: a lost ticket costs a resumption.
            if (session !== undefined) {
              try {
                // Awaited, so an async rejection lands in this catch.
                await onSession(session);
              } catch {
                // The caller could not store it. Nothing here can.
              }
            }
          }
          continue;
        }

        if (decoded.value.kind === 'key_update') {
          keyUpdatesSeen += 1;
          if (keyUpdatesSeen > MAX_KEY_UPDATES) {
            return abortWith('unexpected_message');
          }
          const hashLen = CIPHER_SUITES[suite].hashLength;
          serverTrafficSecret = await hkdfExpandLabel(
            suite,
            serverTrafficSecret,
            'traffic upd',
            new Uint8Array(0),
            hashLen,
          );
          serverAppKeys = await trafficKeys(suite, serverTrafficSecret);
          serverAppSeq = 0n;

          if (decoded.value.requestUpdate) {
            keyUpdateResponseOwed = true;
          }
          continue;
        }

        return abortWith('unexpected_message');
      }
    },

    write: async (plaintext: Uint8Array): Promise<TlsWriteResult> => {
      if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
      // Our own close_notify is what ends writing. The peer's does not.
      if (sentCloseNotify) {
        return {
          ok: false,
          reason: {
            kind: 'alert-sent',
            alert: { level: 'warning', description: 'close_notify' },
          },
        };
      }

      const run = async (): Promise<TlsWriteResult> => {
        if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
        await payKeyUpdateResponse();
        const hashLen = CIPHER_SUITES[suite].hashLength;
        if (clientAppSeq >= MAX_AES_GCM_RECORDS) {
          const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });
          const sealedKu = await sealAead(
            clientAppKeys.key,
            clientAppKeys.iv,
            clientAppSeq,
            'handshake',
            kuMsg,
          );
          clientAppSeq += 1n;
          await peer.transport.write(sealedKu);

          clientTrafficSecret = await hkdfExpandLabel(
            suite,
            clientTrafficSecret,
            'traffic upd',
            new Uint8Array(0),
            hashLen,
          );
          clientAppKeys = await trafficKeys(suite, clientTrafficSecret);
          clientAppSeq = 0n;
        }

        // §5.1: at most 2^14 bytes per record.
        for (let offset = 0; offset < plaintext.length; offset += MAX_RECORD_PLAINTEXT) {
          const sealed = await sealAead(
            clientAppKeys.key,
            clientAppKeys.iv,
            clientAppSeq,
            'application_data',
            plaintext.subarray(offset, offset + MAX_RECORD_PLAINTEXT),
          );
          clientAppSeq += 1n;
          await peer.transport.write(sealed);
        }
        return { ok: true };
      };

      return queueWrite(run);
    },

    close: async (): Promise<TlsCloseResult> => {
      if (sentCloseNotify) return { ok: true };
      sentCloseNotify = true;

      const run = async (): Promise<TlsCloseResult> => {
        await payKeyUpdateResponse();
        const alertPayload = encodeAlert({ level: 'warning', description: 'close_notify' });
        const sealedAlert = await sealAead(
          clientAppKeys.key,
          clientAppKeys.iv,
          clientAppSeq,
          'alert',
          alertPayload,
        );
        clientAppSeq += 1n;
        try {
          await peer.transport.write(sealedAlert);
          return { ok: true };
        } catch {
          // Transport write failure only — crypto errors above must propagate.
          return { ok: false, reason: { kind: 'truncated' } };
        }
      };

      return queueWrite(run);
    },

    // Not queued: it reads a fixed secret and touches no sequence number.
    exportKeyingMaterial: (label, context, length) =>
      exportKeyingMaterial(suite, exporterMaster, label, context ?? new Uint8Array(0), length),
  };
};

export const createTls12Connection = ({
  peer,
  suite,
  hasExtendedMasterSecret,
  masterSecret,
  clientRandom,
  serverRandom,
  keys,
  initialClientWriteSeq,
  initialServerReadSeq,
}: {
  readonly peer: HandshakePeer;
  readonly suite: Tls12CipherSuite;
  readonly hasExtendedMasterSecret: boolean;
  readonly masterSecret: Uint8Array;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly keys: Tls12KeyBlock;
  readonly initialClientWriteSeq: bigint;
  readonly initialServerReadSeq: bigint;
}): TlsConnection => {
  let clientAppSeq = initialClientWriteSeq;
  let serverAppSeq = initialServerReadSeq;
  let peerSentCloseNotify = false;
  let sentCloseNotify = false;
  let hasWrittenCloseNotify = false;
  let terminalFailure: TlsFailure | null = null;

  peer.setRecordSealer(
    createTls12AeadSealer(
      () => ({ key: keys.clientWriteKey, iv: keys.clientWriteIv, seq: clientAppSeq }),
      () => {
        clientAppSeq += 1n;
      },
    ),
  );

  const queueWrite = createWriteQueue();

  const failWith = (reason: TlsFailure): { readonly ok: false; readonly reason: TlsFailure } => {
    terminalFailure ??= reason;
    return { ok: false, reason };
  };

  const abortWith = async (
    description: Alert['description'],
  ): Promise<{ readonly ok: false; readonly reason: TlsFailure }> => {
    const reason: TlsFailure = { kind: 'alert-sent', alert: { level: 'fatal', description } };
    terminalFailure ??= reason;
    await queueWrite(async () => {
      await peer.sendFatalAlert(description);
    });
    return { ok: false, reason };
  };

  /** Must run inside `queueWrite`. Returns `false` if the transport failed while sending. */
  const sendCloseNotifyOnce = async (): Promise<boolean> => {
    if (hasWrittenCloseNotify) return true;
    hasWrittenCloseNotify = true;
    const alertPayload = encodeAlert({ level: 'warning', description: 'close_notify' });
    const sealedAlert = await sealTls12Aead(
      keys.clientWriteKey,
      keys.clientWriteIv,
      clientAppSeq,
      'alert',
      alertPayload,
    );
    clientAppSeq += 1n;
    try {
      await peer.transport.write(sealedAlert);
      return true;
    } catch {
      return false;
    }
  };

  let emptyRecordsSeen = 0;
  let warningAlertsSeen = 0;

  return {
    read: async (): Promise<TlsReadResult> => {
      while (true) {
        if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
        if (peerSentCloseNotify) return { ok: true, kind: 'closed' };

        const recResult = await peer.reader.readRecord();
        if (!recResult.ok) {
          if (recResult.kind === 'truncated') {
            return failWith({ kind: 'truncated' });
          }
          return abortWith(recResult.description);
        }
        if (recResult.kind === 'eof') {
          return failWith({ kind: 'truncated' });
        }

        const openRes = await openTls12Aead(
          keys.serverWriteKey,
          keys.serverWriteIv,
          serverAppSeq,
          recResult.record,
        );
        serverAppSeq += 1n;
        if (!openRes.ok) {
          return abortWith(openRes.description);
        }

        if (openRes.type === 'application_data') {
          if (openRes.payload.length === 0) {
            emptyRecordsSeen += 1;
            if (emptyRecordsSeen > MAX_CONSECUTIVE_EMPTY_RECORDS) {
              return abortWith('unexpected_message');
            }
            continue;
          }
          emptyRecordsSeen = 0;
          warningAlertsSeen = 0;
          return { ok: true, kind: 'data', bytes: openRes.payload };
        }

        if (openRes.type === 'alert') {
          const alertRes = decodeAlert(openRes.payload);
          if (!alertRes.ok) {
            if (alertRes.unknownDescriptionCode !== undefined) {
              return failWith({
                kind: 'alert-received-unknown',
                code: alertRes.unknownDescriptionCode,
              });
            }
            return abortWith(alertRes.description);
          }
          if (alertRes.alert.description === 'close_notify') {
            peerSentCloseNotify = true;
            return { ok: true, kind: 'closed' };
          }
          // RFC 5246 §7.2.2: warning-level alerts (other than `close_notify`, handled above) are
          // non-fatal in TLS 1.2, bounded by BoringSSL's consecutive-warning ceiling.
          if (alertRes.alert.level === 'warning') {
            warningAlertsSeen += 1;
            if (warningAlertsSeen > MAX_WARNING_ALERTS) {
              return abortWith('unexpected_message');
            }
            continue;
          }
          return failWith({ kind: 'alert-received', alert: alertRes.alert });
        }

        if (openRes.type === 'handshake') {
          if (openRes.payload.length === 0) {
            return abortWith('unexpected_message');
          }
          peer.pushHandshakeBytes(openRes.payload);
          let extracted = peer.extractNextHandshakeMessage();
          while (extracted.kind === 'need-more') {
            const more = await peer.reader.readRecord();
            if (!more.ok) {
              if (more.kind === 'truncated') {
                return failWith({ kind: 'truncated' });
              }
              return abortWith(more.description);
            }
            if (more.kind === 'eof') {
              return failWith({ kind: 'truncated' });
            }
            const moreOpen = await openTls12Aead(
              keys.serverWriteKey,
              keys.serverWriteIv,
              serverAppSeq,
              more.record,
            );
            serverAppSeq += 1n;
            if (!moreOpen.ok) {
              return abortWith(moreOpen.description);
            }
            if (moreOpen.type !== 'handshake' || moreOpen.payload.length === 0) {
              return abortWith('unexpected_message');
            }
            peer.pushHandshakeBytes(moreOpen.payload);
            extracted = peer.extractNextHandshakeMessage();
          }
          if (extracted.kind === 'overflow') {
            return abortWith('decode_error');
          }

          if (extracted.bytes[0] !== HANDSHAKE_TYPES.hello_request) {
            return abortWith('unexpected_message');
          }

          const decoded = decodeTls12HandshakeMessage(extracted.bytes);
          if (!decoded.ok) {
            return abortWith(decoded.description);
          }
          if (decoded.value.kind === 'hello_request') {
            return abortWith('no_renegotiation');
          }
          return abortWith('unexpected_message');
        }

        return abortWith('unexpected_message');
      }
    },

    write: async (plaintext: Uint8Array): Promise<TlsWriteResult> => {
      if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
      if (sentCloseNotify) {
        return {
          ok: false,
          reason: {
            kind: 'alert-sent',
            alert: { level: 'warning', description: 'close_notify' },
          },
        };
      }

      const run = async (): Promise<TlsWriteResult> => {
        if (terminalFailure !== null) return { ok: false, reason: terminalFailure };
        const chunksNeeded = Math.ceil(plaintext.length / MAX_RECORD_PLAINTEXT);
        // TLS 1.2 has no KeyUpdate: close cleanly before crossing AES-GCM's 2^24-record cap.
        if (clientAppSeq + BigInt(chunksNeeded) > MAX_AES_GCM_RECORDS) {
          sentCloseNotify = true;
          await sendCloseNotifyOnce();
          return {
            ok: false,
            reason: {
              kind: 'alert-sent',
              alert: { level: 'warning', description: 'close_notify' },
            },
          };
        }

        for (let offset = 0; offset < plaintext.length; offset += MAX_RECORD_PLAINTEXT) {
          const sealed = await sealTls12Aead(
            keys.clientWriteKey,
            keys.clientWriteIv,
            clientAppSeq,
            'application_data',
            plaintext.subarray(offset, offset + MAX_RECORD_PLAINTEXT),
          );
          clientAppSeq += 1n;
          await peer.transport.write(sealed);
        }
        return { ok: true };
      };

      return queueWrite(run);
    },

    close: async (): Promise<TlsCloseResult> => {
      if (sentCloseNotify) return { ok: true };
      sentCloseNotify = true;

      const run = async (): Promise<TlsCloseResult> =>
        (await sendCloseNotifyOnce()) ? { ok: true } : { ok: false, reason: { kind: 'truncated' } };

      return queueWrite(run);
    },

    exportKeyingMaterial: async (label, context, length) => {
      // RFC 7627 §5.4 / RFC 9266 §4.2: never export channel-binding material from a non-EMS TLS 1.2 master secret.
      if (!hasExtendedMasterSecret) {
        throw new Error(
          'TLS 1.2 exportKeyingMaterial requires Extended Master Secret (RFC 7627 §5.4 / RFC 9266 §4.2)',
        );
      }
      return tls12ExportKeyingMaterial(
        suite,
        masterSecret,
        clientRandom,
        serverRandom,
        label,
        context,
        length,
      );
    },
  };
};
