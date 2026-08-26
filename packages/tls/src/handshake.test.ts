import { decodeCertificate, type Validator } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Step, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import type { AlertDescription } from './alert.ts';
import { decodeAlert } from './alert.ts';
import { concat } from './bytes.ts';
import { type StartTlsOptions, startTls } from './handshake.ts';
import {
  decodeHandshakeMessage,
  type Extension,
  encodeHandshakeMessage,
  type HandshakeMessage,
} from './handshake-messages.ts';
import {
  deriveSecret,
  earlySecret,
  handshakeSecret,
  hkdfExpandLabel,
  trafficKeys,
} from './key-schedule.ts';
import { deriveSharedSecret, generateKeyShare, importPrivateShare } from './key-share.ts';
import {
  type AeadRecordEvent,
  MAX_RECORD_PLAINTEXT,
  openAead,
  openPlain,
  sealAead,
  sealPlain,
  setAeadObserver,
} from './record.ts';
import { type ReplayHooks, startTlsForReplay } from './replay.ts';
import type { TlsSession } from './session.ts';
import { Transcript } from './transcript.ts';
import { type ByteDuplex, createMemoryDuplex } from './transport.ts';
import {
  type ContentType,
  DOWNGRADE_SENTINEL_TLS_1_1,
  DOWNGRADE_SENTINEL_TLS_1_2,
  HRR_MAGIC_RANDOM,
  NAMED_GROUPS,
  type NamedGroup,
  SIGNATURE_SCHEMES,
  type SignatureScheme,
  TLS_VERSION,
} from './wire.ts';

const bytesOf = (step: Rfc8448Step, label: string): Uint8Array | undefined =>
  step.fields.find(field => field.label === label)?.bytes;

const createTestValidator = (expectedLeafDer: Uint8Array): Validator => ({
  name: 'rfc8448-test-validator',
  validatePath: async req => {
    try {
      const decoded = decodeCertificate(req.peerCertificateDer);
      const isExpected =
        req.peerCertificateDer.length === expectedLeafDer.length &&
        req.peerCertificateDer.every((b, i) => b === expectedLeafDer[i]);

      if (!isExpected) {
        return {
          ok: false,
          reason: {
            code: 'no-path-to-trust-anchor',
          },
        };
      }

      return {
        ok: true,
        path: {
          leafSubjectPublicKeyInfoDer: decoded.subjectPublicKeyInfo.der,
          intermediates: [],
          trustAnchorId: 'rfc8448',
        },
      };
    } catch {
      return {
        ok: false,
        reason: {
          code: 'malformed-certificate',
          certificate: { source: 'peer' },
        },
      };
    }
  },
});

const dummyTrustAnchors = {
  findCandidates: () => [],
};

const extractTraceInputs = (trace: Rfc8448Trace) => {
  const clientHellos: Uint8Array[] = [];
  const clientPrivKeys: Uint8Array[] = [];
  const serverRecords: Uint8Array[] = [];
  const publishedClientHandshakeRecords: Uint8Array[] = [];
  let serverLeafDer: Uint8Array | undefined;
  let publishedClientAppPayload: Uint8Array | undefined;
  let publishedClientAppComplete: Uint8Array | undefined;
  let publishedClientAlertComplete: Uint8Array | undefined;
  let publishedClientCcsComplete: Uint8Array | undefined;
  let clientHsWriteKey: Uint8Array | undefined;
  let clientHsWriteIv: Uint8Array | undefined;
  let serverHsWriteKey: Uint8Array | undefined;
  let serverHsWriteIv: Uint8Array | undefined;
  let certificateRequestContext: Uint8Array | undefined;

  for (const step of trace.steps) {
    if (step.actor === 'client' && step.title.includes('create an ephemeral')) {
      const priv = bytesOf(step, 'private key');
      if (priv !== undefined) clientPrivKeys.push(priv);
    }

    if (step.actor === 'client' && step.title.includes('construct a ClientHello')) {
      const ch = bytesOf(step, 'ClientHello');
      if (ch !== undefined) clientHellos.push(ch);
    }

    if (
      step.actor === 'server' &&
      step.title.includes('derive write traffic keys for handshake data')
    ) {
      const key = bytesOf(step, 'key expanded');
      const iv = bytesOf(step, 'iv expanded');
      if (key !== undefined) serverHsWriteKey = key;
      if (iv !== undefined) serverHsWriteIv = iv;
    }

    // Client HS write keys are published as the server's HS read keys
    // ("same as server handshake data read traffic keys").
    if (
      step.actor === 'server' &&
      step.title.includes('derive read traffic keys for handshake data')
    ) {
      const key = bytesOf(step, 'key expanded');
      const iv = bytesOf(step, 'iv expanded');
      if (key !== undefined) clientHsWriteKey = key;
      if (iv !== undefined) clientHsWriteIv = iv;
    }

    if (
      step.actor === 'client' &&
      step.title.includes('derive write traffic keys for handshake data')
    ) {
      const key = bytesOf(step, 'key expanded');
      const iv = bytesOf(step, 'iv expanded');
      if (key !== undefined) clientHsWriteKey = key;
      if (iv !== undefined) clientHsWriteIv = iv;
    }

    if (step.actor === 'server' && step.title.includes('send') && step.title.includes('record')) {
      const rec = bytesOf(step, 'complete record');
      if (rec !== undefined) serverRecords.push(rec);
    }

    if (
      step.actor === 'client' &&
      step.title.includes('send') &&
      step.title.includes('handshake record')
    ) {
      const rec = bytesOf(step, 'complete record');
      if (rec !== undefined) publishedClientHandshakeRecords.push(rec);
    }

    if (
      step.actor === 'client' &&
      step.title.includes('send') &&
      step.title.includes('change_cipher_spec')
    ) {
      publishedClientCcsComplete = bytesOf(step, 'complete record');
    }

    if (step.actor === 'server' && step.title.includes('construct a Certificate')) {
      const certMsg = bytesOf(step, 'Certificate');
      if (certMsg !== undefined) {
        const decoded = decodeHandshakeMessage(certMsg);
        if (decoded.ok && decoded.value.kind === 'certificate') {
          serverLeafDer = decoded.value.certificateList[0]?.certData;
        }
      }
    }

    if (step.actor === 'server' && step.title.includes('construct a CertificateRequest')) {
      const crMsg = bytesOf(step, 'CertificateRequest');
      if (crMsg !== undefined) {
        const decoded = decodeHandshakeMessage(crMsg);
        if (decoded.ok && decoded.value.kind === 'certificate_request') {
          certificateRequestContext = decoded.value.certificateRequestContext;
        }
      }
    }

    if (step.actor === 'client' && step.title.includes('send application_data record')) {
      publishedClientAppPayload = bytesOf(step, 'payload');
      publishedClientAppComplete = bytesOf(step, 'complete record');
    }

    if (step.actor === 'client' && step.title.includes('send alert record')) {
      publishedClientAlertComplete = bytesOf(step, 'complete record');
    }
  }

  return {
    clientHellos,
    clientPrivKeys,
    serverRecords,
    publishedClientHandshakeRecords,
    serverLeafDer: serverLeafDer ?? new Uint8Array(0),
    publishedClientAppPayload,
    publishedClientAppComplete,
    publishedClientAlertComplete,
    publishedClientCcsComplete,
    clientHsWriteKey,
    clientHsWriteIv,
    serverHsWriteKey,
    serverHsWriteIv,
    certificateRequestContext,
  };
};

/** The server's EE‖Cert‖CV‖Fin arrives coalesced in one record; a mutation needs them apart. */
const splitHandshakeMessages = (payload: Uint8Array): Uint8Array[] => {
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset < payload.length) {
    const length =
      (payload[offset + 1]! << 16) | (payload[offset + 2]! << 8) | payload[offset + 3]!;
    messages.push(payload.subarray(offset, offset + 4 + length));
    offset += 4 + length;
  }
  return messages;
};

const drainClientWrites = async (server: ByteDuplex): Promise<Uint8Array[]> => {
  const writes: Uint8Array[] = [];
  while (true) {
    const raced = await Promise.race([
      server.read().then(chunk => ({ kind: 'chunk' as const, chunk })),
      new Promise<{ kind: 'timeout' }>(resolve => {
        setTimeout(() => resolve({ kind: 'timeout' }), 20);
      }),
    ]);
    if (raced.kind === 'timeout') break;
    if (raced.chunk === null) break;
    writes.push(raced.chunk);
  }
  return writes;
};

const findAlertDescriptionOnWire = async (
  writes: readonly Uint8Array[],
  hsKey?: Uint8Array,
  hsIv?: Uint8Array,
): Promise<string | undefined> => {
  for (const record of writes) {
    if (record[0] === 0x15) {
      const plain = openPlain(record);
      if (!plain.ok || plain.type !== 'alert') continue;
      const alert = decodeAlert(plain.payload);
      if (alert.ok) return alert.alert.description;
    }
    if (record[0] === 0x17 && hsKey !== undefined && hsIv !== undefined) {
      // Fatal alerts after ServerHello are the first client HS seal (seq 0).
      const opened = await openAead(hsKey, hsIv, 0n, record);
      if (opened.ok && opened.type === 'alert') {
        const alert = decodeAlert(opened.payload);
        if (alert.ok) return alert.alert.description;
      }
    }
  }
  return undefined;
};

describe('Stage 7: Handshake state machine & scripted peer', () => {
  describe('Gate A — scripted peer, byte-exact against RFC 8448', () => {
    it('§3 Simple 1-RTT full handshake, app write, and close', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const duplex = createMemoryDuplex();

      const peerFeed = async () => {
        for (const rec of inputs.serverRecords) {
          await duplex.server.write(rec);
        }
      };

      const replay: ReplayHooks = {
        clientHelloMessages: inputs.clientHellos,
        clientEphemeralPrivateKeys: inputs.clientPrivKeys,
      };

      const clientOptions: StartTlsOptions & { replay: ReplayHooks } = {
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(inputs.serverLeafDer),
        replay,
      };

      const [clientResult] = await Promise.all([startTlsForReplay(clientOptions), peerFeed()]);

      expect(clientResult.ok).toBe(true);
      if (!clientResult.ok) return;

      const connection = clientResult.connection;

      // ClientHello then Finished — byte-exact against the published records
      const chRec = await duplex.server.read();
      expect(chRec).toEqual(inputs.publishedClientHandshakeRecords[0]);
      const finRec = await duplex.server.read();
      expect(finRec).toEqual(inputs.publishedClientHandshakeRecords[1]);

      // NST then app data from peer
      const readResult = await connection.read();
      expect(readResult).toEqual({
        ok: true,
        kind: 'data',
        bytes: bytesOf(
          trace3.steps.find(
            s => s.actor === 'server' && s.title.includes('send application_data'),
          )!,
          'payload',
        )!,
      });

      const appWritePromise = connection.write(inputs.publishedClientAppPayload!);
      const clientAppRecord = await duplex.server.read();
      await appWritePromise;
      expect(clientAppRecord).toEqual(inputs.publishedClientAppComplete);

      const closePromise = connection.close();
      const clientAlertRecord = await duplex.server.read();
      await closePromise;
      expect(clientAlertRecord).toEqual(inputs.publishedClientAlertComplete);

      // Peer close_notify must be consumed as a clean close
      const peerClose = await connection.read();
      expect(peerClose).toEqual({ ok: true, kind: 'closed' });
    });

    it('§5 HelloRetryRequest replay', async () => {
      const trace5 = RFC_8448_TRACES.find(t => t.section === '5')!;
      const inputs = extractTraceInputs(trace5);
      const duplex = createMemoryDuplex();

      let writtenCh2: Uint8Array | undefined;
      const peerFeed = async () => {
        await duplex.server.read(); // CH1
        await duplex.server.write(inputs.serverRecords[0]!); // HRR
        writtenCh2 = (await duplex.server.read()) ?? undefined; // CH2
        for (let i = 1; i < inputs.serverRecords.length; i += 1) {
          await duplex.server.write(inputs.serverRecords[i]!);
        }
      };

      const replay: ReplayHooks = {
        clientHelloMessages: inputs.clientHellos,
        clientEphemeralPrivateKeys: inputs.clientPrivKeys,
      };

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay,
        }),
        peerFeed(),
      ]);

      expect(clientResult.ok).toBe(true);
      // Injected CH2 must be written byte-exact (cookie already inside)
      expect(writtenCh2).toEqual(inputs.publishedClientHandshakeRecords[1]);
      const finRec = await duplex.server.read();
      expect(finRec).toEqual(inputs.publishedClientHandshakeRecords[2]);
    });

    it('§7 Compatibility Mode (CCS handling and emission)', async () => {
      const trace7 = RFC_8448_TRACES.find(t => t.section === '7')!;
      const inputs = extractTraceInputs(trace7);
      const duplex = createMemoryDuplex();

      const peerFeed = async () => {
        for (const rec of inputs.serverRecords) {
          await duplex.server.write(rec);
        }
      };

      const replay: ReplayHooks = {
        clientHelloMessages: inputs.clientHellos,
        clientEphemeralPrivateKeys: inputs.clientPrivKeys,
      };

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay,
        }),
        peerFeed(),
      ]);

      expect(clientResult.ok).toBe(true);

      const chRec = await duplex.server.read();
      expect(chRec).toEqual(inputs.publishedClientHandshakeRecords[0]);

      const ccsRec = await duplex.server.read();
      expect(ccsRec).toEqual(Uint8Array.of(0x14, 0x03, 0x03, 0x00, 0x01, 0x01));
      expect(ccsRec).toEqual(inputs.publishedClientCcsComplete);

      const finRec = await duplex.server.read();
      expect(finRec).toEqual(inputs.publishedClientHandshakeRecords[1]);
    });

    it('§6 Client Authentication (declines certificate, sends empty cert + Finished)', async () => {
      const trace6 = RFC_8448_TRACES.find(t => t.section === '6')!;
      const inputs = extractTraceInputs(trace6);
      const duplex = createMemoryDuplex();

      const sealedTypes: ContentType[] = [];
      setAeadObserver(event => {
        if (event.direction === 'seal') sealedTypes.push(event.type);
      });

      const peerFeed = async () => {
        for (const rec of inputs.serverRecords) {
          await duplex.server.write(rec);
        }
      };

      const replay: ReplayHooks = {
        clientHelloMessages: inputs.clientHellos,
        clientEphemeralPrivateKeys: inputs.clientPrivKeys,
      };

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay,
        }),
        peerFeed(),
      ]).finally(() => setAeadObserver(null));

      expect(clientResult.ok).toBe(true);

      const chRec = await duplex.server.read();
      expect(chRec).toEqual(inputs.publishedClientHandshakeRecords[0]);

      expect(inputs.clientHsWriteKey).toBeDefined();
      expect(inputs.clientHsWriteIv).toBeDefined();
      expect(inputs.certificateRequestContext).toBeDefined();

      // Decline: empty Certificate (echo context) then Finished — NOT the published client cert/CV
      const emptyCertRec = await duplex.server.read();
      const expectedEmptyCert = await sealAead(
        inputs.clientHsWriteKey!,
        inputs.clientHsWriteIv!,
        0n,
        'handshake',
        encodeHandshakeMessage({
          kind: 'certificate',
          certificateRequestContext: inputs.certificateRequestContext!,
          certificateList: [],
        }),
      );
      expect(emptyCertRec).toEqual(expectedEmptyCert);

      const finRec = await duplex.server.read();
      expect(finRec).toBeDefined();
      const openedFin = await openAead(
        inputs.clientHsWriteKey!,
        inputs.clientHsWriteIv!,
        1n,
        finRec!,
      );
      expect(openedFin.ok).toBe(true);
      if (!openedFin.ok) return;
      expect(openedFin.type).toBe('handshake');
      const finMsg = decodeHandshakeMessage(openedFin.payload);
      expect(finMsg.ok).toBe(true);
      if (!finMsg.ok) return;
      expect(finMsg.value.kind).toBe('finished');

      // Must not have sent the published client Certificate (which carries a cert entry)
      expect(emptyCertRec).not.toEqual(inputs.publishedClientHandshakeRecords[1]);
      expect(sealedTypes).not.toContain('application_data');
    });
  });

  describe('Gate B — Fail-closed invariant checks', () => {
    const runFailClosedTest = async (
      serverAction: (serverDuplex: ByteDuplex) => Promise<void>,
      expectedAlert: AlertDescription | 'truncated',
      validator?: Validator,
      signatureSchemes?: readonly SignatureScheme[],
    ) => {
      const duplex = createMemoryDuplex();
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      // ROADMAP's M6 gate is not "it returned a failure" — it is that NO
      // APPLICATION DATA WAS EVER SENT. A client that leaks a byte of mail
      // before deciding the peer is untrustworthy passes every other assertion
      // in this helper.
      const sealed: ContentType[] = [];
      setAeadObserver(event => {
        if (event.direction === 'seal') sealed.push(event.type);
      });

      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: validator ?? createTestValidator(inputs.serverLeafDer),
        ...(signatureSchemes === undefined ? {} : { signatureSchemes }),
        replay: {
          clientHelloMessages: inputs.clientHellos,
          clientEphemeralPrivateKeys: inputs.clientPrivKeys,
        },
      });

      const serverPromise = serverAction(duplex.server);
      const [clientResult] = await Promise.all([clientPromise, serverPromise]).finally(() =>
        setAeadObserver(null),
      );

      expect(sealed).not.toContain('application_data');
      expect(clientResult.ok).toBe(false);
      if (clientResult.ok) return;

      if (expectedAlert === 'truncated') {
        expect(clientResult.reason.kind).toBe('truncated');
        return;
      }

      expect(clientResult.reason.kind).not.toBe('truncated');
      if (
        clientResult.reason.kind !== 'truncated' &&
        clientResult.reason.kind !== 'alert-received-unknown'
      ) {
        expect(clientResult.reason.alert.description).toBe(expectedAlert);
      }

      // Assert the expected fatal alert actually went out on the wire
      const writes = await drainClientWrites(duplex.server);
      const wireAlert = await findAlertDescriptionOnWire(
        writes,
        inputs.clientHsWriteKey,
        inputs.clientHsWriteIv,
      );
      expect(wireAlert).toBe(expectedAlert);
    };

    it('ServerHello with no supported_versions -> protocol_version', async () => {
      await runFailClosedTest(async server => {
        await server.read(); // read CH
        const rawSh12: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        const rec = sealPlain('handshake', encodeHandshakeMessage(rawSh12));
        await server.write(rec);
      }, 'protocol_version');
    });

    it('ServerHello.random ends in DOWNGRD01 -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const random = new Uint8Array(32);
        random.set(DOWNGRADE_SENTINEL_TLS_1_2, 24);
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random,
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('ServerHello.random ends in DOWNGRD00 -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const random = new Uint8Array(32);
        random.set(DOWNGRADE_SENTINEL_TLS_1_1, 24);
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random,
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('Certificate before ServerHello -> unexpected_message', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const cert: HandshakeMessage = {
          kind: 'certificate',
          certificateRequestContext: new Uint8Array(0),
          certificateList: [],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(cert)));
      }, 'unexpected_message');
    });

    it('App data before handshake keys exist -> unexpected_message', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const appRec = Uint8Array.of(0x17, 0x03, 0x03, 0x00, 0x05, 1, 2, 3, 4, 5);
        await server.write(appRec);
      }, 'unexpected_message');
    });

    it('SH key_share group we did not offer -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x0019, keyExchange: new Uint8Array(32) } }, // 0x0019 not offered
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('SH suite 0x1303 (ChaCha20) -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1303, // ChaCha20 not accepted
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('Missing key_share in SH -> missing_extension', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'missing_extension');
    });

    it('Second HRR -> unexpected_message', async () => {
      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const serverPromise = (async () => {
        const ch1Rec = await duplex.server.read(); // read CH1
        const ch1Plain = openPlain(ch1Rec!);
        if (!ch1Plain.ok) throw new Error('expected ClientHello record');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('expected ClientHello');
        const hrr: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: HRR_MAGIC_RANDOM,
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', selectedGroup: 0x0017 },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
        await duplex.server.read(); // read CH2
        // Send a second HRR
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
      })();

      const [clientResult] = await Promise.all([clientPromise, serverPromise]);
      expect(clientResult.ok).toBe(false);
      if (!clientResult.ok) {
        expect(clientResult.reason.kind).not.toBe('truncated');
        if (
          clientResult.reason.kind !== 'truncated' &&
          clientResult.reason.kind !== 'alert-received-unknown'
        ) {
          expect(clientResult.reason.alert.description).toBe('unexpected_message');
        }
      }
    });

    /**
     * RFC 9846 §4.3.8 puts two conditions on a HelloRetryRequest's group, and
     * both are `illegal_parameter`. BoGo covers neither against a TLS 1.3
     * client — `curve_tests.go` carries a TODO for the first — so these are the
     * only thing holding either check in place.
     */
    describe('a HelloRetryRequest may only move us to a group we can go to', () => {
      const retryTo = async (
        selectedGroup: number,
        supportedGroups: readonly NamedGroup[],
      ): Promise<string | undefined> => {
        const duplex = createMemoryDuplex();
        const clientPromise = startTls({
          transport: duplex.client,
          serverName: 'mail.example.com',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date(),
          validator: {
            name: 'dummy',
            validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
          },
          supportedGroups,
        });

        const serverPromise = (async () => {
          const ch1Rec = await duplex.server.read();
          const ch1Plain = openPlain(ch1Rec!);
          if (!ch1Plain.ok) throw new Error('expected ClientHello record');
          const ch1 = decodeHandshakeMessage(ch1Plain.payload);
          if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('expected ClientHello');
          const hrr: HandshakeMessage = {
            kind: 'server_hello',
            legacyVersion: 0x0303,
            random: HRR_MAGIC_RANDOM,
            legacySessionIdEcho: ch1.value.legacySessionId,
            cipherSuite: 0x1301,
            legacyCompressionMethod: 0,
            extensions: [
              { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
              { kind: 'key_share', selectedGroup },
            ],
          };
          await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
        })();

        const [clientResult] = await Promise.all([clientPromise, serverPromise]);
        if (clientResult.ok) return undefined;
        const { reason } = clientResult;
        return reason.kind === 'truncated' || reason.kind === 'alert-received-unknown'
          ? reason.kind
          : reason.alert.description;
      };

      it('refuses a group that was not in our supported_groups', async () => {
        // We implement P-384, so this is the offer check failing on its own and
        // not "we cannot do that curve".
        expect(await retryTo(NAMED_GROUPS.secp384r1, ['x25519', 'secp256r1'])).toBe(
          'illegal_parameter',
        );
      });

      it('refuses a group we do not implement at all', async () => {
        // 0x0019 is secp521r1.
        expect(await retryTo(0x0019, ['x25519', 'secp256r1', 'secp384r1'])).toBe(
          'illegal_parameter',
        );
      });

      it('offers what the caller passed, even if the caller mutates it after', async () => {
        // The list is read again for the ClientHello an HRR asks for, a round
        // trip later, and §4.2.4 wants that one to offer what the first did. So
        // the option is COPIED — aliasing it would also let a caller invalidate
        // the checks above after they had already passed.
        const groups: NamedGroup[] = ['secp384r1', 'secp256r1'];
        const duplex = createMemoryDuplex();
        const clientPromise = startTls({
          transport: duplex.client,
          serverName: 'mail.example.com',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date(),
          validator: {
            name: 'dummy',
            validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
          },
          supportedGroups: groups,
        });
        groups.splice(0, groups.length, 'x25519', 'x25519');

        const ch1Rec = await duplex.server.read();
        const ch1Plain = openPlain(ch1Rec!);
        if (!ch1Plain.ok) throw new Error('expected ClientHello record');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('expected ClientHello');

        expect(ch1.value.extensions.find(e => e.kind === 'supported_groups')).toEqual({
          kind: 'supported_groups',
          groups: [NAMED_GROUPS.secp384r1, NAMED_GROUPS.secp256r1],
        });
        const ks = ch1.value.extensions.find(e => e.kind === 'key_share');
        expect(ks?.kind === 'key_share' && ks.clientShares?.[0]?.group).toBe(
          NAMED_GROUPS.secp384r1,
        );

        duplex.close();
        await clientPromise;
      });

      it('refuses to build a ClientHello offering the same group twice', async () => {
        // RFC 9846 §4.3.7: "The `named_group_list` MUST NOT contain any
        // duplicate entries. A recipient MAY abort a connection with a fatal
        // `illegal_parameter` alert if it detects a duplicate entry." Ours to
        // catch, so it throws instead of reaching the wire.
        await expect(
          startTls({
            transport: createMemoryDuplex().client,
            serverName: 'mail.example.com',
            trustAnchors: dummyTrustAnchors,
            validationTime: new Date(),
            validator: {
              name: 'dummy',
              validatePath: async () => ({
                ok: false,
                reason: { code: 'no-path-to-trust-anchor' },
              }),
            },
            supportedGroups: ['x25519', 'secp256r1', 'x25519'],
          }),
        ).rejects.toThrow(/repeat a group/);
      });

      it('refuses the group it already has our key share for', async () => {
        // The retry would change nothing, which §4.2.4 forbids in as many
        // words. Without this check a server can spend our key generation on a
        // round trip that buys the handshake nothing.
        expect(await retryTo(NAMED_GROUPS.x25519, ['x25519', 'secp256r1'])).toBe(
          'illegal_parameter',
        );
      });
    });

    it('One flipped byte in §3 encrypted server flight -> bad_record_mac', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      await runFailClosedTest(async server => {
        await server.read(); // CH
        await server.write(inputs.serverRecords[0]!); // SH
        // Mutate second record (encrypted EE+Cert+CV+Fin)
        const mutatedFlight = new Uint8Array(inputs.serverRecords[1]!);
        mutatedFlight[20]! ^= 0x01;
        await server.write(mutatedFlight);
      }, 'bad_record_mac');
    });

    it('Outer length 2^14+257 -> record_overflow', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const overflow = Uint8Array.of(0x16, 0x03, 0x03, 0x41, 0x01, ...new Uint8Array(16641));
        await server.write(overflow);
      }, 'record_overflow');
    });

    it('Truncated header then EOF -> truncated', async () => {
      const duplex = createMemoryDuplex();
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      // ROADMAP's M6 gate is not "it returned a failure" — it is that NO
      // APPLICATION DATA WAS EVER SENT. A client that leaks a byte of mail
      // before deciding the peer is untrustworthy passes every other assertion
      // in this helper.
      const sealed: ContentType[] = [];
      setAeadObserver(event => {
        if (event.direction === 'seal') sealed.push(event.type);
      });

      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(inputs.serverLeafDer),
        replay: {
          clientHelloMessages: inputs.clientHellos,
          clientEphemeralPrivateKeys: inputs.clientPrivKeys,
        },
      });

      const serverPromise = (async () => {
        await duplex.server.read();
        await duplex.server.write(Uint8Array.of(0x16, 0x03)); // 2 bytes header then EOF
        duplex.close();
      })();

      const [clientResult] = await Promise.all([clientPromise, serverPromise]);
      expect(clientResult.ok).toBe(false);
      if (!clientResult.ok) {
        expect(clientResult.reason.kind).toBe('truncated');
      }
    });

    it('validatePath failure -> unknown_ca / certificate failure', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      const rejectingValidator: Validator = {
        name: 'rejecting',
        validatePath: async () => ({
          ok: false,
          reason: { code: 'no-path-to-trust-anchor' },
        }),
      };

      await runFailClosedTest(
        async server => {
          for (const rec of inputs.serverRecords) {
            await server.write(rec);
          }
        },
        'unknown_ca',
        rejectingValidator,
      );
    });

    /**
     * The sibling of the test above, and the reason both exist: a validator has
     * two ways to say no and they are not the same alert. `no-path-to-trust-anchor`
     * is a conclusion about the CHAIN; `rejected-by-policy` is a refusal that is
     * not about the chain at all, which RFC 9846 §6.2 calls "some other
     * (unspecified) issue ... rendering it unacceptable".
     *
     * Trust-on-first-use is what makes this worth pinning rather than a detail
     * of the BoGo shim: a pin mismatch validates a chain perfectly and refuses
     * it anyway, and reporting that as `unknown_ca` would tell the user their
     * mail host has an untrusted CA when its key simply changed.
     */
    it('validatePath rejected-by-policy -> certificate_unknown', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      const refusingValidator: Validator = {
        name: 'refusing-on-policy',
        validatePath: async () => ({
          ok: false,
          reason: { code: 'rejected-by-policy' },
        }),
      };

      await runFailClosedTest(
        async server => {
          for (const rec of inputs.serverRecords) {
            await server.write(rec);
          }
        },
        'certificate_unknown',
        refusingValidator,
      );
    });

    it('bad server Finished verify_data -> decrypt_error', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      expect(inputs.serverHsWriteKey).toBeDefined();
      expect(inputs.serverHsWriteIv).toBeDefined();

      await runFailClosedTest(async server => {
        await server.read();
        await server.write(inputs.serverRecords[0]!); // SH

        const openFlight = await openAead(
          inputs.serverHsWriteKey!,
          inputs.serverHsWriteIv!,
          0n,
          inputs.serverRecords[1]!,
        );
        expect(openFlight.ok).toBe(true);
        if (!openFlight.ok) return;

        // Split coalesced EE‖Cert‖CV‖Fin and flip the Finished verify_data
        const messages = splitHandshakeMessages(openFlight.payload);
        const finished = new Uint8Array(messages[messages.length - 1]!);
        finished[finished.length - 1]! ^= 0x01;
        messages[messages.length - 1] = finished;
        const mutatedPayload = concat(...messages);
        const mutatedRecord = await sealAead(
          inputs.serverHsWriteKey!,
          inputs.serverHsWriteIv!,
          0n,
          'handshake',
          mutatedPayload,
        );
        await server.write(mutatedRecord);
      }, 'decrypt_error');
    });

    it('bad CertificateVerify -> decrypt_error', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      await runFailClosedTest(async server => {
        await server.read();
        await server.write(inputs.serverRecords[0]!);

        const openFlight = await openAead(
          inputs.serverHsWriteKey!,
          inputs.serverHsWriteIv!,
          0n,
          inputs.serverRecords[1]!,
        );
        expect(openFlight.ok).toBe(true);
        if (!openFlight.ok) return;

        const messages = splitHandshakeMessages(openFlight.payload);
        // CertificateVerify is the third message (EE, Cert, CV, Fin)
        const cv = new Uint8Array(messages[2]!);
        cv[cv.length - 1]! ^= 0x01;
        messages[2] = cv;
        const mutatedRecord = await sealAead(
          inputs.serverHsWriteKey!,
          inputs.serverHsWriteIv!,
          0n,
          'handshake',
          concat(...messages),
        );
        await server.write(mutatedRecord);
      }, 'decrypt_error');
    });

    /**
     * RFC 9846 §4.3: a server may only answer an extension the client offered,
     * and only where that extension is defined. BoGo has thirteen tests on this
     * one rule and the client passed every one of them by accepting — including
     * an unsolicited OCSP response stapled to a certificate we never asked to be
     * stapled.
     */
    const unofferedExtension = {
      kind: 'unknown',
      typeCode: 0xabcd,
      data: new Uint8Array(0),
    } as const;

    it('ServerHello carrying an extension we never offered -> unsupported_extension', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
            unofferedExtension,
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'unsupported_extension');
    });

    /**
     * Both of these mutate §3's real encrypted flight, so everything up to the
     * mutated message is the document's own bytes. The transcript moves and the
     * signature and MAC after it stop verifying — which is fine, and is the
     * point: the client must refuse at the extension, before it ever gets there.
     */
    const mutateServerFlight = async (
      mutate: (messages: Uint8Array[]) => void,
      expectedAlert: AlertDescription,
    ): Promise<void> => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);

      await runFailClosedTest(async server => {
        await server.read();
        await server.write(inputs.serverRecords[0]!);

        const openFlight = await openAead(
          inputs.serverHsWriteKey!,
          inputs.serverHsWriteIv!,
          0n,
          inputs.serverRecords[1]!,
        );
        expect(openFlight.ok).toBe(true);
        if (!openFlight.ok) return;

        const messages = splitHandshakeMessages(openFlight.payload);
        mutate(messages);
        await server.write(
          await sealAead(
            inputs.serverHsWriteKey!,
            inputs.serverHsWriteIv!,
            0n,
            'handshake',
            concat(...messages),
          ),
        );
      }, expectedAlert);
    };

    it('EncryptedExtensions carrying an extension we never offered -> unsupported_extension', async () => {
      await mutateServerFlight(messages => {
        const decoded = decodeHandshakeMessage(messages[0]!);
        if (!decoded.ok || decoded.value.kind !== 'encrypted_extensions') {
          throw new Error('§3 message 0 is not EncryptedExtensions');
        }
        messages[0] = encodeHandshakeMessage({
          kind: 'encrypted_extensions',
          extensions: [...decoded.value.extensions, unofferedExtension],
        });
      }, 'unsupported_extension');
    });

    it('a CertificateEntry carrying any extension -> unsupported_extension', async () => {
      await mutateServerFlight(messages => {
        const decoded = decodeHandshakeMessage(messages[1]!);
        if (!decoded.ok || decoded.value.kind !== 'certificate') {
          throw new Error('§3 message 1 is not Certificate');
        }
        messages[1] = encodeHandshakeMessage({
          ...decoded.value,
          certificateList: decoded.value.certificateList.map((entry, index) =>
            // rawExtensions is verbatim and wins over `extensions` on re-encode,
            // so it has to go for the added extension to reach the wire.
            index === 0 ? { certData: entry.certData, extensions: [unofferedExtension] } : entry,
          ),
        });
      }, 'unsupported_extension');
    });

    /**
     * RFC 9846 §4.5.2: a server's CertificateVerify "signature algorithm MUST be
     * one offered in the client's `signature_algorithms` extension".
     *
     * BoGo holds this too — `VerifyPreferences-Enforced` narrows the client to
     * RSA-PSS-SHA384, hands the runner a credential that signs only SHA-256 and
     * SHA-512, sets `IgnorePeerSignatureAlgorithmPreferences` and demands
     * `illegal_parameter`. Delete the check below and it turns into an
     * `unexpected success`, the gate's most dangerous column.
     *
     * These two are here anyway because they run in `pnpm test`, which needs
     * neither a Go toolchain nor the 337MB checkout, and because they isolate
     * the rule from the scheme's implementation: `VerifyPreferences-Enforced`
     * would also fail if `rsa_pss_rsae_sha384` were broken.
     *
     * §3's CertificateVerify is `rsa_pss_rsae_sha256`, and the replay's
     * ClientHello is the document's own, so narrowing the option changes only
     * what the client will ACCEPT. That is the half being tested: the scheme is
     * one `verify.ts` implements, and the refusal has to come from it not having
     * been offered.
     */
    it('a CertificateVerify scheme we implement but did not offer -> illegal_parameter', async () => {
      await runFailClosedTest(
        async server => {
          const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
          const inputs = extractTraceInputs(trace3);
          await server.read();
          await server.write(inputs.serverRecords[0]!);
          await server.write(inputs.serverRecords[1]!);
        },
        'illegal_parameter',
        undefined,
        ['ecdsa_secp256r1_sha256'],
      );
    });

    it('the same flight is accepted when that scheme IS offered', async () => {
      // The mutation test above proves a refusal; without this one it could be
      // refusing §3's flight for any reason at all.
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const duplex = createMemoryDuplex();
      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(inputs.serverLeafDer),
        signatureSchemes: ['rsa_pss_rsae_sha256'],
        replay: {
          clientHelloMessages: inputs.clientHellos,
          clientEphemeralPrivateKeys: inputs.clientPrivKeys,
        },
      });
      await duplex.server.read();
      await duplex.server.write(inputs.serverRecords[0]!);
      await duplex.server.write(inputs.serverRecords[1]!);
      const result = await clientPromise;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // And the scheme it verified under is what the caller is told.
      expect(result.peerSignatureScheme).toBe('rsa_pss_rsae_sha256');
    });

    it('bytes trailing the ServerHello inside its own record -> unexpected_message', async () => {
      // RFC 9846 §5.1: a handshake message may not span a key change, and the
      // keys change right here. Left alone, these bytes would be spliced onto
      // the front of the decrypted flight.
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      await runFailClosedTest(async server => {
        await server.read();
        const plain = openPlain(inputs.serverRecords[0]!);
        if (!plain.ok) throw new Error('§3 record 0 is not plaintext');
        await server.write(
          sealPlain('handshake', concat(plain.payload, Uint8Array.of(0x08, 0x00))),
        );
      }, 'unexpected_message');
    });

    it('bytes trailing the server Finished inside its flight -> unexpected_message', async () => {
      await mutateServerFlight(messages => {
        messages.push(Uint8Array.of(0x02, 0x00));
      }, 'unexpected_message');
    });

    it('a server refusing the ClientHello is reported in ITS words, not ours', async () => {
      // A cleartext alert here is the only sentence in the exchange that says
      // why. Answering it with our own unexpected_message threw that away, and
      // left "unexpected message" as the whole diagnosis for a server that
      // simply speaks no TLS 1.3.
      const duplex = createMemoryDuplex();
      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      await duplex.server.read();
      await duplex.server.write(sealPlain('alert', Uint8Array.of(2, 70)));

      expect(await startPromise).toEqual({
        ok: false,
        reason: {
          kind: 'alert-received',
          alert: { level: 'fatal', description: 'protocol_version' },
        },
      });
    });

    it('bytes trailing a HelloRetryRequest inside its own record -> unexpected_message', async () => {
      await runFailClosedTest(async server => {
        const ch1Plain = openPlain((await server.read())!);
        if (!ch1Plain.ok) throw new Error('ClientHello1 is not plaintext');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('no ClientHello1');
        const hrr: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: HRR_MAGIC_RANDOM,
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp256r1 },
          ],
        };
        // The retry ends the flight; our ClientHello2 is what comes next.
        await server.write(
          sealPlain('handshake', concat(encodeHandshakeMessage(hrr), Uint8Array.of(0x02, 0x00))),
        );
      }, 'unexpected_message');
    });

    it('a HelloRetryRequest asking for neither a group nor a cookie -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        const ch1Record = await server.read();
        const ch1Plain = openPlain(ch1Record!);
        if (!ch1Plain.ok) throw new Error('ClientHello1 is not plaintext');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('no ClientHello1');
        const hrr: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: HRR_MAGIC_RANDOM,
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
      }, 'illegal_parameter');
    });

    it('a key_share in EncryptedExtensions -> illegal_parameter', async () => {
      // RFC 9846 §4.3 draws the line: an extension we never offered is
      // unsupported_extension, but one we DID offer, in a message where it is
      // not defined, "MUST abort the handshake with an illegal_parameter
      // alert". Parsing a ClientHello-shaped key_share out of an
      // EncryptedExtensions produced a decode_error and hid which fault it was.
      await mutateServerFlight(messages => {
        const decoded = decodeHandshakeMessage(messages[0]!);
        if (!decoded.ok || decoded.value.kind !== 'encrypted_extensions') {
          throw new Error('§3 message 0 is not EncryptedExtensions');
        }
        messages[0] = encodeHandshakeMessage({
          kind: 'encrypted_extensions',
          extensions: [
            ...decoded.value.extensions,
            {
              kind: 'key_share',
              serverShare: { group: NAMED_GROUPS.x25519, keyExchange: new Uint8Array(32) },
            },
          ],
        });
      }, 'illegal_parameter');
    });

    it('an empty Certificate from the server -> decode_error', async () => {
      // RFC 9846 §4.5.1 names this alert, and it is not a complaint about a
      // certificate: there was none to complain about.
      await mutateServerFlight(messages => {
        const decoded = decodeHandshakeMessage(messages[1]!);
        if (!decoded.ok || decoded.value.kind !== 'certificate') {
          throw new Error('§3 message 1 is not Certificate');
        }
        messages[1] = encodeHandshakeMessage({ ...decoded.value, certificateList: [] });
      }, 'decode_error');
    });

    it('legacy_version != 0x0303 -> protocol_version', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0301,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
        // §4.2.3 names this alert: "A client which receives a TLS 1.3 Server
        // Hello with a legacy_version value not equal to 0x0303 MUST abort the
        // handshake with a protocol_version alert." This test asserted
        // illegal_parameter, and pinned the wrong one.
      }, 'protocol_version');
    });

    it('legacy_compression_method != 0 -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 1,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('session-id echo mismatch -> illegal_parameter', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: Uint8Array.of(1, 2, 3, 4),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('post-HRR ServerHello changing the suite -> illegal_parameter', async () => {
      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const serverPromise = (async () => {
        const ch1Rec = await duplex.server.read();
        const ch1Plain = openPlain(ch1Rec!);
        if (!ch1Plain.ok) throw new Error('ch1');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('ch1 msg');
        const hrr: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: HRR_MAGIC_RANDOM,
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', selectedGroup: 0x0017 },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
        await duplex.server.read(); // CH2
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1302, // changed from HRR's 0x1301
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            {
              kind: 'key_share',
              serverShare: { group: 0x0017, keyExchange: new Uint8Array(65) },
            },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      })();

      const [clientResult] = await Promise.all([clientPromise, serverPromise]);
      expect(clientResult.ok).toBe(false);
      if (
        !clientResult.ok &&
        clientResult.reason.kind !== 'truncated' &&
        clientResult.reason.kind !== 'alert-received-unknown'
      ) {
        expect(clientResult.reason.alert.description).toBe('illegal_parameter');
      }
    });

    it('zero-length X25519 share -> illegal_parameter (typed, not rejected)', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(0) } },
          ],
        };
        await server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      }, 'illegal_parameter');
    });

    it('65-byte non-point P-256 share -> illegal_parameter (typed, not rejected)', async () => {
      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const serverPromise = (async () => {
        const ch1Rec = await duplex.server.read();
        const ch1Plain = openPlain(ch1Rec!);
        if (!ch1Plain.ok) throw new Error('ch1');
        const ch1 = decodeHandshakeMessage(ch1Plain.payload);
        if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('ch1 msg');
        const hrr: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: HRR_MAGIC_RANDOM,
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', selectedGroup: 0x0017 },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
        await duplex.server.read();
        // Uncompressed prefix but not a valid curve point
        const bogus = new Uint8Array(65);
        bogus[0] = 0x04;
        bogus.fill(0x11, 1);
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: ch1.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            { kind: 'key_share', serverShare: { group: 0x0017, keyExchange: bogus } },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
      })();

      const [clientResult] = await Promise.all([clientPromise, serverPromise]);
      expect(clientResult.ok).toBe(false);
      if (!clientResult.ok) {
        expect(clientResult.reason.kind).toBe('alert-sent');
        if (clientResult.reason.kind === 'alert-sent') {
          expect(clientResult.reason.alert.description).toBe('illegal_parameter');
        }
      }
    });

    it('handshake message longer than 64 KiB -> decode_error without buffering it', async () => {
      await runFailClosedTest(async server => {
        await server.read();
        // Declared length 65537, one byte over the cap, with almost no body sent:
        // the point is that the DECLARED size is refused before anything is held.
        const overflowMsg = Uint8Array.of(0x02, 0x01, 0x00, 0x01, 0x00, 0x00);
        await server.write(sealPlain('handshake', overflowMsg));
      }, 'decode_error');
    });

    it('ServerHello split across two plaintext records completes', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const duplex = createMemoryDuplex();

      const shRecord = inputs.serverRecords[0]!;
      const plain = openPlain(shRecord);
      expect(plain.ok).toBe(true);
      if (!plain.ok) return;
      const payload = plain.payload;
      const mid = Math.floor(payload.length / 2);
      const rec1 = sealPlain('handshake', payload.subarray(0, mid));
      const rec2 = sealPlain('handshake', payload.subarray(mid));

      const peerFeed = async () => {
        await duplex.server.write(rec1);
        await duplex.server.write(rec2);
        for (let i = 1; i < inputs.serverRecords.length; i += 1) {
          await duplex.server.write(inputs.serverRecords[i]!);
        }
      };

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay: {
            clientHelloMessages: inputs.clientHellos,
            clientEphemeralPrivateKeys: inputs.clientPrivKeys,
          },
        }),
        peerFeed(),
      ]);
      expect(clientResult.ok).toBe(true);
    });

    /**
     * Named for what it checks. It does NOT show the state machine rebinding its
     * transcript, only that `Transcript` is 48 bytes when constructed for
     * SHA-384 and that a 0x1302 ServerHello is not refused. The rebind is pinned
     * in `interop.test.ts`, where removing it fails the three AES-256 rows.
     */
    it('accepts a 0x1302 ServerHello, and Transcript widens on request', async () => {
      const defaultTranscript = new Transcript();
      defaultTranscript.add(Uint8Array.of(1, 2, 3, 4));
      expect((await defaultTranscript.hash()).length).toBe(32);

      const sha384 = new Transcript('TLS_AES_256_GCM_SHA384');
      sha384.add(Uint8Array.of(1, 2, 3, 4));
      expect((await sha384.hash()).length).toBe(48);

      // SM accepts 0x1302 and proceeds into the encrypted epoch (AEAD), not reject the suite.
      // (Wire-alert decrypt uses §3 AES-128 keys, so this case checks the returned reason only.)
      const peerShare = await generateKeyShare('x25519');
      const duplex = createMemoryDuplex();
      const sealed: ContentType[] = [];
      setAeadObserver(event => {
        if (event.direction === 'seal') sealed.push(event.type);
      });
      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(
          extractTraceInputs(RFC_8448_TRACES.find(t => t.section === '3')!).serverLeafDer,
        ),
        replay: {
          clientHelloMessages: extractTraceInputs(RFC_8448_TRACES.find(t => t.section === '3')!)
            .clientHellos,
          clientEphemeralPrivateKeys: extractTraceInputs(
            RFC_8448_TRACES.find(t => t.section === '3')!,
          ).clientPrivKeys,
        },
      });
      const serverPromise = (async () => {
        await duplex.server.read();
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: new Uint8Array(32),
          legacySessionIdEcho: new Uint8Array(0),
          cipherSuite: 0x1302,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            {
              kind: 'key_share',
              serverShare: { group: 0x001d, keyExchange: peerShare.publicKey },
            },
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
        await duplex.server.write(
          Uint8Array.of(0x17, 0x03, 0x03, 0x00, 0x15, ...new Uint8Array(21)),
        );
      })();
      const [clientResult] = await Promise.all([clientPromise, serverPromise]).finally(() =>
        setAeadObserver(null),
      );
      expect(sealed).not.toContain('application_data');
      expect(clientResult.ok).toBe(false);
      if (!clientResult.ok && clientResult.reason.kind === 'alert-sent') {
        expect(clientResult.reason.alert.description).toBe('bad_record_mac');
      }
    });

    /**
     * A real AES-256 epoch: the peer derives `s hs traffic` under SHA-384 and
     * seals with it, and the client opens it. Nothing else in this suite drives
     * an AEAD record under `TLS_AES_256_GCM_SHA384` through the state machine.
     *
     * It does NOT gate the transcript rebind, and cannot: the traffic secrets
     * call `deriveSecret(negotiatedSuite, …, ...messages)`, which hashes with the
     * negotiated suite whatever width the `Transcript` object carries. The rebind
     * only changes `transcript.hash()`, which is read at CertificateVerify and at
     * both Finisheds — so gating it needs a peer that can complete a whole flight
     * under AES-256, including a CertificateVerify that actually verifies. That
     * peer is the outstanding half of M6.
     */
    it('opens an AES-256 handshake record sealed under SHA-384 keys', async () => {
      const SUITE_384 = 'TLS_AES_256_GCM_SHA384';
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const clientHello = inputs.clientHellos[0]!;
      const clientPrivateKey = inputs.clientPrivKeys[0]!;

      const peerShare = await generateKeyShare('x25519');
      const serverHello: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random: new Uint8Array(32),
        legacySessionIdEcho: new Uint8Array(0),
        cipherSuite: 0x1302,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: peerShare.publicKey } },
        ],
      };
      const serverHelloBytes = encodeHandshakeMessage(serverHello);

      // Same shared secret either way round, and the trace hands us the client half.
      const clientPair = await importPrivateShare('x25519', clientPrivateKey);
      const shared = await deriveSharedSecret('x25519', clientPair.privateKey, peerShare.publicKey);
      const handshake = await handshakeSecret(SUITE_384, await earlySecret(SUITE_384), shared);
      const serverKeys = await trafficKeys(
        SUITE_384,
        await deriveSecret(SUITE_384, handshake, 's hs traffic', clientHello, serverHelloBytes),
      );

      const duplex = createMemoryDuplex();
      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(inputs.serverLeafDer),
        replay: {
          clientHelloMessages: [clientHello],
          clientEphemeralPrivateKeys: [clientPrivateKey],
        },
      });
      const serverPromise = (async () => {
        await duplex.server.read();
        await duplex.server.write(sealPlain('handshake', serverHelloBytes));
        await duplex.server.write(
          await sealAead(
            serverKeys.key,
            serverKeys.iv,
            0n,
            'handshake',
            encodeHandshakeMessage({ kind: 'encrypted_extensions', extensions: [] }),
          ),
        );
        duplex.close();
      })();

      const [clientResult] = await Promise.all([clientPromise, serverPromise]);

      expect(clientResult.ok).toBe(false);
      if (clientResult.ok) return;
      // The peer stopped after EncryptedExtensions, so the honest outcome is a
      // truncated stream. `bad_record_mac` here means the client's transcript was
      // the wrong width and it never opened the record at all.
      expect(clientResult.reason).not.toMatchObject({ alert: { description: 'bad_record_mac' } });
    });
  });

  describe('Gate C — production ClientHello properties', () => {
    it('generates a full production ClientHello when run without replay', async () => {
      const duplex = createMemoryDuplex();

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const clientHelloRecord = await duplex.server.read();
      expect(clientHelloRecord).toBeDefined();

      const plainRes = openPlain(clientHelloRecord!);
      expect(plainRes.ok).toBe(true);
      if (!plainRes.ok) return;

      const decoded = decodeHandshakeMessage(plainRes.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') return;

      const ch = decoded.value;
      expect(ch.cipherSuites).toEqual([0x1301, 0x1302]);
      expect(ch.legacySessionId.length).toBe(32);

      const sni = ch.extensions.find(e => e.kind === 'server_name');
      expect(sni).toEqual({ kind: 'server_name', serverNames: ['mail.example.com'] });

      const groups = ch.extensions.find(e => e.kind === 'supported_groups');
      expect(groups).toEqual({
        kind: 'supported_groups',
        groups: [NAMED_GROUPS.x25519, NAMED_GROUPS.secp256r1, NAMED_GROUPS.secp384r1],
      });

      const versions = ch.extensions.find(e => e.kind === 'supported_versions');
      expect(versions).toEqual({
        kind: 'supported_versions',
        versions: [TLS_VERSION.V1_3],
        isServerHello: false,
      });

      const ks = ch.extensions.find(e => e.kind === 'key_share');
      expect(ks?.kind).toBe('key_share');
      if (ks?.kind === 'key_share') {
        expect(ks.clientShares?.length).toBe(1);
        expect(ks.clientShares?.[0]?.group).toBe(NAMED_GROUPS.x25519);
        expect(ks.clientShares?.[0]?.keyExchange.length).toBe(32);
      }

      duplex.close();
      await startPromise;
    });
  });

  describe('Gate C2 — a ClientHello too large for one record', () => {
    /**
     * A ticket comes back as the PSK identity, so the SERVER decides how big our
     * next ClientHello is. 16384 octets is the largest one this client will keep
     * — the ceiling `sessionFromTicket` enforces — and it already overruns a
     * single 2^14 record, which sealing used to answer with a bare
     * `Error: record_overflow`: a peer-chosen value poisoning the connection
     * AFTER the one it arrived on, before a byte went out.
     */
    it('fragments across records instead of throwing', async () => {
      const duplex = createMemoryDuplex();
      const ticket = crypto.getRandomValues(new Uint8Array(16_384));

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
        session: {
          serverName: 'mail.example.com',
          expectedPeerName: { kind: 'dns', value: 'mail.example.com' },
          suite: 'TLS_AES_128_GCM_SHA256',
          ticket,
          preSharedKey: new Uint8Array(32),
          ticketAgeAdd: 0,
          receivedAt: new Date(),
          authenticatedAt: new Date(),
          peerSignatureScheme: 'ecdsa_secp256r1_sha256',
          peerCertificateChain: { leafDer: Uint8Array.of(0x30, 0x00), intermediateDer: [] },
          lifetimeSeconds: 600,
        },
      });

      const first = await duplex.server.read();
      const second = await duplex.server.read();
      if (first == null || second == null) {
        throw new Error('the ClientHello did not arrive as two records');
      }

      const payloads = [first, second].map(record => {
        const opened = openPlain(record);
        if (!opened.ok || opened.type !== 'handshake') throw new Error('not a handshake record');
        // §5.1 caps TLSPlaintext.length at 2^14, and a peer that reads a longer
        // one is required to send record_overflow.
        expect(opened.payload.length).toBeLessThanOrEqual(16384);
        return opened.payload;
      });

      // Fragmenting is only correct if the pieces are the message. A decoder
      // fed the first record alone would see a truncated ClientHello.
      const decoded = decodeHandshakeMessage(concat(...payloads));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') return;
      const psk = decoded.value.extensions.find(e => e.kind === 'pre_shared_key');
      expect(psk?.kind === 'pre_shared_key' && psk.identities?.[0]?.identity).toEqual(ticket);

      duplex.close();
      await startPromise;
    });
  });

  /**
   * Both of these are MUST-level rules with NO BoGo coverage — the suite never
   * puts a `pre_shared_key` in a HelloRetryRequest, and it maps a missing
   * `key_share` to one internal error whichever alert we choose. So this file is
   * the only thing holding them, which is exactly when a test is owed.
   */
  describe('Gate C3 — what a server may say back to a PSK offer', () => {
    const offeredSession: TlsSession = {
      serverName: 'mail.example.com',
      expectedPeerName: { kind: 'dns', value: 'mail.example.com' },
      suite: 'TLS_AES_128_GCM_SHA256',
      ticket: Uint8Array.of(1, 2, 3, 4),
      preSharedKey: new Uint8Array(32),
      ticketAgeAdd: 0,
      receivedAt: new Date(),
      authenticatedAt: new Date(),
      peerSignatureScheme: 'ecdsa_secp256r1_sha256',
      peerCertificateChain: { leafDer: Uint8Array.of(0x30, 0x00), intermediateDer: [] },
      lifetimeSeconds: 600,
    };

    const answerClientHello = async (
      reply: (sessionId: Uint8Array) => HandshakeMessage,
      session: TlsSession | undefined,
    ): Promise<AlertDescription | undefined> => {
      const duplex = createMemoryDuplex();
      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
        session,
      });

      const helloRecord = await duplex.server.read();
      if (helloRecord == null) throw new Error('no ClientHello');
      const opened = openPlain(helloRecord);
      if (!opened.ok) throw new Error('ClientHello is not plaintext');
      const decoded = decodeHandshakeMessage(opened.payload);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') throw new Error('no ClientHello');

      // The reply is fragmented the way a real server would have to: a
      // HelloRetryRequest carrying a large cookie does not fit one record
      // either, and `sealPlain` throws rather than splitting.
      const replyBytes = encodeHandshakeMessage(reply(decoded.value.legacySessionId));
      for (let at = 0; at < replyBytes.length; at += MAX_RECORD_PLAINTEXT) {
        await duplex.server.write(
          sealPlain('handshake', replyBytes.subarray(at, at + MAX_RECORD_PLAINTEXT)),
        );
      }
      const result = await startPromise;
      duplex.close();
      return result.ok === false && result.reason.kind === 'alert-sent'
        ? result.reason.alert.description
        : undefined;
    };

    /**
     * RFC 9846's Table 1 gives `pre_shared_key` the messages `CH, SH` — HRR is a
     * column of its own and it is not in it — and §4.3 makes an extension in a
     * message where it is not defined an `illegal_parameter`. Offering a session
     * is what made this reachable: before it, 41 was not in the offered set.
     */
    it('refuses a HelloRetryRequest carrying pre_shared_key', async () => {
      expect(
        await answerClientHello(
          legacySessionId => ({
            kind: 'server_hello',
            legacyVersion: 0x0303,
            random: HRR_MAGIC_RANDOM,
            legacySessionIdEcho: legacySessionId,
            cipherSuite: 0x1301,
            legacyCompressionMethod: 0,
            extensions: [
              { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
              { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp256r1 },
              { kind: 'pre_shared_key', selectedIdentity: 0 },
            ],
          }),
          offeredSession,
        ),
      ).toBe('illegal_parameter');
    });

    /**
     * A cookie is `opaque cookie<1..2^16-1>` and a ClientHello's extensions are
     * `Extension extensions<8..2^16-1>` — the whole BLOCK is a uint16. So a
     * cookie near its own maximum makes a retried ClientHello that CANNOT be
     * encoded by anyone, and fragmenting records does not help: the limit is the
     * message's, not the record's. Unbounded, the encoder threw a bare
     * `writeUint16 invalid value` out of `startTls`, which is an unhandled
     * rejection where every other peer-caused failure is `{ ok: false }`.
     */
    it('refuses a HelloRetryRequest cookie it could not echo', async () => {
      expect(
        await answerClientHello(
          legacySessionId => ({
            kind: 'server_hello',
            legacyVersion: 0x0303,
            random: HRR_MAGIC_RANDOM,
            legacySessionIdEcho: legacySessionId,
            cipherSuite: 0x1301,
            legacyCompressionMethod: 0,
            extensions: [
              { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
              { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp256r1 },
              { kind: 'cookie', cookie: new Uint8Array(16_385) },
            ],
          }),
          undefined,
        ),
      ).toBe('illegal_parameter');
    });

    /**
     * §4.3.11 is one sentence with three clauses — `selected_identity` in range,
     * a matching Hash, "and that a server `key_share` extension is present if
     * required by the ClientHello `psk_key_exchange_modes` extension. If these
     * values are not consistent, the client MUST abort the handshake with an
     * `illegal_parameter` alert." We offer `psk_dhe_ke` alone, so a selected PSK
     * always requires the share.
     *
     * The second half is the one that keeps the first honest: with no PSK there
     * is no such sentence, and the missing mandatory extension of §9.2 earns
     * `missing_extension`. One alert for both would pass either assertion alone.
     */
    it('tells the two missing key_shares apart', async () => {
      const serverHello = (extensions: Extension[]) => (legacySessionId: Uint8Array) =>
        ({
          kind: 'server_hello',
          legacyVersion: 0x0303,
          random: crypto.getRandomValues(new Uint8Array(32)),
          legacySessionIdEcho: legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            ...extensions,
          ],
        }) satisfies HandshakeMessage;

      expect(
        await answerClientHello(
          serverHello([{ kind: 'pre_shared_key', selectedIdentity: 0 }]),
          offeredSession,
        ),
      ).toBe('illegal_parameter');

      expect(await answerClientHello(serverHello([]), undefined)).toBe('missing_extension');
    });
  });

  describe('Gate D — constructed P-384 HRR', () => {
    it('an aborted handshake sends the dummy ChangeCipherSpec before its protected alert', async () => {
      // RFC 9846 D.4 owes one ChangeCipherSpec before the second flight, and an
      // abort makes the fatal alert that flight. Without it the peer reads the
      // protected alert as a malformed ChangeCipherSpec and never learns why we
      // hung up — which is how sixteen BoGo tests were failing.
      const duplex = createMemoryDuplex();
      const serverShare = await generateKeyShare('x25519');

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const ch1Record = (await duplex.server.read())!;
      expect(ch1Record[0]).toBe(0x16);
      const ch1Plain = openPlain(ch1Record);
      if (!ch1Plain.ok) throw new Error('ClientHello1 is not plaintext');
      const ch1 = decodeHandshakeMessage(ch1Plain.payload);
      if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('no ClientHello1');

      const sh: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random: crypto.getRandomValues(new Uint8Array(32)),
        legacySessionIdEcho: ch1.value.legacySessionId,
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          {
            kind: 'key_share',
            serverShare: { group: NAMED_GROUPS.x25519, keyExchange: serverShare.publicKey },
          },
        ],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));

      // Undecryptable, so the client aborts with a protected bad_record_mac.
      const garbage = concat(
        Uint8Array.of(0x17, 0x03, 0x03, 0x00, 0x20),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      await duplex.server.write(garbage);

      const ccsRecord = (await duplex.server.read())!;
      expect(ccsRecord[0]).toBe(0x14);
      expect(ccsRecord.subarray(5)).toEqual(Uint8Array.of(1));

      const alertRecord = (await duplex.server.read())!;
      expect(alertRecord[0]).toBe(0x17);

      expect(await startPromise).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'bad_record_mac' } },
      });
    });

    it('a cookie-only HelloRetryRequest keeps the same key share and echoes the cookie', async () => {
      const duplex = createMemoryDuplex();

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      const ch1Plain = openPlain((await duplex.server.read())!);
      expect(ch1Plain.ok).toBe(true);
      if (!ch1Plain.ok) return;
      const ch1Decoded = decodeHandshakeMessage(ch1Plain.payload);
      expect(ch1Decoded.ok).toBe(true);
      if (!ch1Decoded.ok || ch1Decoded.value.kind !== 'client_hello') return;
      const ch1Share = ch1Decoded.value.extensions.find(e => e.kind === 'key_share');

      // A retry may ask for a cookie and nothing else. RFC 9846 §4.2.2: the
      // second ClientHello then differs only by the cookie — the same share
      // goes back out, because generating a fresh one answers a question the
      // server never asked.
      const cookie = new TextEncoder().encode('come back with this');
      const hrr: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random: HRR_MAGIC_RANDOM,
        legacySessionIdEcho: ch1Decoded.value.legacySessionId,
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          { kind: 'cookie', cookie },
        ],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));

      const ccsRecord = await duplex.server.read();
      expect(ccsRecord?.[0]).toBe(0x14);

      const ch2Plain = openPlain((await duplex.server.read())!);
      expect(ch2Plain.ok).toBe(true);
      if (!ch2Plain.ok) return;
      const ch2Decoded = decodeHandshakeMessage(ch2Plain.payload);
      expect(ch2Decoded.ok).toBe(true);
      if (!ch2Decoded.ok || ch2Decoded.value.kind !== 'client_hello') return;

      expect(ch2Decoded.value.extensions.find(e => e.kind === 'key_share')).toEqual(ch1Share);
      expect(ch2Decoded.value.extensions.find(e => e.kind === 'cookie')).toEqual({
        kind: 'cookie',
        cookie,
      });

      duplex.close();
      await startPromise;
    });

    /**
     * RFC 9846 §4.2.2 lists what the second ClientHello may change, and
     * `signature_algorithms` is not on it — so a narrowed offer has to survive
     * the retry. Nothing else holds this: BoGo's `VerifyPreferences-Advertised`
     * reads the extension off the FIRST ClientHello and never retries, so
     * dropping `signatureSchemes` from the second encoding leaves both gates
     * green while the client advertises six schemes and accepts one.
     */
    it('carries a narrowed signature_algorithms through the HelloRetryRequest', async () => {
      const duplex = createMemoryDuplex();
      const narrowed: readonly SignatureScheme[] = ['ed25519', 'ecdsa_secp384r1_sha384'];
      const expected = {
        kind: 'signature_algorithms',
        schemes: narrowed.map(name => SIGNATURE_SCHEMES[name]),
      };

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
        signatureSchemes: narrowed,
      });

      const ch1Plain = openPlain((await duplex.server.read())!);
      expect(ch1Plain.ok).toBe(true);
      if (!ch1Plain.ok) return;
      const ch1Decoded = decodeHandshakeMessage(ch1Plain.payload);
      expect(ch1Decoded.ok).toBe(true);
      if (!ch1Decoded.ok || ch1Decoded.value.kind !== 'client_hello') return;
      expect(ch1Decoded.value.extensions.find(e => e.kind === 'signature_algorithms')).toEqual(
        expected,
      );

      const hrr: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random: HRR_MAGIC_RANDOM,
        legacySessionIdEcho: ch1Decoded.value.legacySessionId,
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp384r1 },
        ],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));

      const ccsRecord = await duplex.server.read();
      expect(ccsRecord?.[0]).toBe(0x14);

      const ch2Plain = openPlain((await duplex.server.read())!);
      expect(ch2Plain.ok).toBe(true);
      if (!ch2Plain.ok) return;
      const ch2Decoded = decodeHandshakeMessage(ch2Plain.payload);
      expect(ch2Decoded.ok).toBe(true);
      if (!ch2Decoded.ok || ch2Decoded.value.kind !== 'client_hello') return;

      expect(ch2Decoded.value.extensions.find(e => e.kind === 'signature_algorithms')).toEqual(
        expected,
      );

      duplex.close();
      await startPromise;
    });

    it('generates a 97-byte P-384 key share in ClientHello2 after HRR selecting 0x0018', async () => {
      const duplex = createMemoryDuplex();

      const startPromise = startTls({
        transport: duplex.client,
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
      });

      // Read CH1
      const ch1Record = await duplex.server.read();
      const ch1Plain = openPlain(ch1Record!);
      expect(ch1Plain.ok).toBe(true);
      if (!ch1Plain.ok) return;
      const ch1Decoded = decodeHandshakeMessage(ch1Plain.payload);
      expect(ch1Decoded.ok).toBe(true);
      if (!ch1Decoded.ok || ch1Decoded.value.kind !== 'client_hello') return;
      const ch1 = ch1Decoded.value;

      // Send HRR selecting secp384r1 (0x0018), echoing CH1's session id
      const hrr: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random: HRR_MAGIC_RANDOM,
        legacySessionIdEcho: ch1.legacySessionId,
        cipherSuite: 0x1302,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp384r1 },
        ],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));

      // RFC 9846 D.4: the dummy ChangeCipherSpec goes out immediately before the
      // second flight, which after a retry is ClientHello2 rather than Finished.
      const ccsRecord = await duplex.server.read();
      expect(ccsRecord?.[0]).toBe(0x14);
      expect(ccsRecord?.subarray(5)).toEqual(Uint8Array.of(1));

      // Read CH2
      const ch2Record = await duplex.server.read();
      expect(ch2Record).toBeDefined();

      const plainRes = openPlain(ch2Record!);
      expect(plainRes.ok).toBe(true);
      if (!plainRes.ok) return;

      const decoded = decodeHandshakeMessage(plainRes.payload);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') return;

      // RFC 9846 §4.2.2: CH2 reuses CH1's random
      expect(decoded.value.random).toEqual(ch1.random);
      expect(decoded.value.legacySessionId).toEqual(ch1.legacySessionId);

      const ks = decoded.value.extensions.find(e => e.kind === 'key_share');
      expect(ks?.kind).toBe('key_share');
      if (ks?.kind === 'key_share') {
        expect(ks.clientShares?.length).toBe(1);
        expect(ks.clientShares?.[0]?.group).toBe(NAMED_GROUPS.secp384r1);
        expect(ks.clientShares?.[0]?.keyExchange.length).toBe(97); // 1 + 48 + 48 uncompressed point
        expect(ks.clientShares?.[0]?.keyExchange[0]).toBe(0x04);
      }

      duplex.close();
      await startPromise;
    });
  });

  describe('Gate E — KeyUpdate', () => {
    it('handles KeyUpdate(update_requested), rotates keys, and communicates under new keys', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const duplex = createMemoryDuplex();

      const peerFeed = async () => {
        // Feed SH, encrypted flight, NST, app data (omit close_notify)
        for (const rec of inputs.serverRecords.slice(0, 4)) {
          await duplex.server.write(rec);
        }
      };

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay: {
            clientHelloMessages: inputs.clientHellos,
            clientEphemeralPrivateKeys: inputs.clientPrivKeys,
          },
        }),
        peerFeed(),
      ]);

      expect(clientResult.ok).toBe(true);
      if (!clientResult.ok) return;

      const conn = clientResult.connection;
      // Read published server app data
      await conn.read();

      // Derive initial server and client app traffic secrets from trace 3
      const s_ap_step = trace3.steps.find(s => s.title === 'derive secret "tls13 s ap traffic"')!;
      const c_ap_step = trace3.steps.find(s => s.title === 'derive secret "tls13 c ap traffic"')!;
      const s_ap = bytesOf(s_ap_step, 'expanded')!;
      const c_ap = bytesOf(c_ap_step, 'expanded')!;

      // Server sends KeyUpdate(update_requested) under current server write keys (seq = 2)
      const currentServerKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', s_ap);
      const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: true });
      const sealedKu = await sealAead(
        currentServerKeys.key,
        currentServerKeys.iv,
        2n,
        'handshake',
        kuMsg,
      );
      await duplex.server.write(sealedKu);

      // Server sends new app data under ROTATED server write keys (seq = 0)
      const newServerSecret = await hkdfExpandLabel(
        'TLS_AES_128_GCM_SHA256',
        s_ap,
        'traffic upd',
        new Uint8Array(0),
        32,
      );
      const newServerKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', newServerSecret);
      const postKuPayload = new TextEncoder().encode('message after key update');
      const postKuRecord = await sealAead(
        newServerKeys.key,
        newServerKeys.iv,
        0n,
        'application_data',
        postKuPayload,
      );
      await duplex.server.write(postKuRecord);

      // Read client handshake records (ClientHello and Finished)
      const chRec = await duplex.server.read();
      expect(chRec).toBeDefined();
      const finRec = await duplex.server.read();
      expect(finRec).toBeDefined();

      // Client reads: processes KeyUpdate, updates keys, reads app data
      const postKuRead = await conn.read();
      expect(postKuRead).toEqual({
        ok: true,
        kind: 'data',
        bytes: postKuPayload,
      });

      // The response KeyUpdate is owed, not sent: it goes out with the next
      // thing the client writes, which is what keeps a burst of requests from
      // becoming a burst of replies.
      const newClientSecret = await hkdfExpandLabel(
        'TLS_AES_128_GCM_SHA256',
        c_ap,
        'traffic upd',
        new Uint8Array(0),
        32,
      );
      const newClientKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', newClientSecret);

      const clientWritePayload = new TextEncoder().encode('client data after key update');
      const clientWritePromise = conn.write(clientWritePayload);

      // The KeyUpdate under the OLD write keys, then the data under the rotated ones.
      const clientKuRecord = await duplex.server.read();
      expect(clientKuRecord).toBeDefined();
      const clientRotatedRecord = await duplex.server.read();
      await clientWritePromise;

      expect(clientRotatedRecord).toBeDefined();
      const openClientRes = await openAead(
        newClientKeys.key,
        newClientKeys.iv,
        0n,
        clientRotatedRecord!,
      );
      expect(openClientRes).toEqual({
        ok: true,
        type: 'application_data',
        payload: clientWritePayload,
      });
    });
  });

  /**
   * A ceiling is only a ceiling if something is measured against it. TLS 1.3
   * lets a peer send padding-only records, `user_canceled` alerts and
   * `KeyUpdate`s without limit, and each of these sends one more than we take.
   */
  describe('Gate F — ceilings on records that carry no progress', () => {
    const SUITE = 'TLS_AES_128_GCM_SHA256';

    /** §3 replayed to a live connection, plus the server's own app-write keys. */
    const establishedConnection = async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const duplex = createMemoryDuplex();

      const [clientResult] = await Promise.all([
        startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay: {
            clientHelloMessages: inputs.clientHellos,
            clientEphemeralPrivateKeys: inputs.clientPrivKeys,
          },
        }),
        (async () => {
          // SH and the encrypted flight only — the published app data would
          // consume a sequence number these tests need to control.
          for (const rec of inputs.serverRecords.slice(0, 2)) {
            await duplex.server.write(rec);
          }
        })(),
      ]);

      if (!clientResult.ok) throw new Error('the §3 replay did not connect');

      // §3's ClientHello carries no session id, so the client owes no
      // compatibility ChangeCipherSpec: ClientHello then Finished, and both have
      // to come off the wire before a test can read what it sent afterwards.
      expect(((await duplex.server.read()) ?? [])[0]).toBe(0x16);
      expect(((await duplex.server.read()) ?? [])[0]).toBe(0x17);

      const secretOf = (label: string) =>
        bytesOf(
          trace3.steps.find(step => step.title === `derive secret "tls13 ${label}"`)!,
          'expanded',
        )!;
      return {
        connection: clientResult.connection,
        server: duplex.server,
        serverSecret: secretOf('s ap traffic'),
        clientSecret: secretOf('c ap traffic'),
      };
    };

    it('a 33rd consecutive empty record -> unexpected_message', async () => {
      const { connection, server, serverSecret } = await establishedConnection();
      const keys = await trafficKeys(SUITE, serverSecret);
      for (let seq = 0n; seq < 33n; seq += 1n) {
        await server.write(
          await sealAead(keys.key, keys.iv, seq, 'application_data', new Uint8Array(0)),
        );
      }
      expect(await connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });

    it('32 empty records then real data -> the data, and nothing about the padding', async () => {
      const { connection, server, serverSecret } = await establishedConnection();
      const keys = await trafficKeys(SUITE, serverSecret);
      let seq = 0n;
      for (; seq < 32n; seq += 1n) {
        await server.write(
          await sealAead(keys.key, keys.iv, seq, 'application_data', new Uint8Array(0)),
        );
      }
      const payload = new TextEncoder().encode('after the padding');
      await server.write(await sealAead(keys.key, keys.iv, seq, 'application_data', payload));

      expect(await connection.read()).toEqual({ ok: true, kind: 'data', bytes: payload });
    });

    it('a byte of application data clears every ceiling', async () => {
      /**
       * BoringSSL's own rule, in as many words: "Only when at least one byte is
       * returned, clear the counters for empty records and warnings"
       * (`ssl/tls_record.cc`), with `key_update_count` cleared on delivered data
       * in `ssl/ssl_lib.cc`. All three count CONSECUTIVE occurrences.
       *
       * Counted over a connection's lifetime instead, these limits kill an
       * ordinary IMAP session on its 33rd rekey, hours in — the one connection
       * this client exists to hold open.
       */
      const { connection, server, serverSecret } = await establishedConnection();
      const payload = new TextEncoder().encode('progress');
      const keyUpdate = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });

      // The peer's write state: one secret, one sequence number, and a KeyUpdate
      // moves both — which is the whole reason this needs a helper rather than
      // arithmetic at each call site.
      let secret = serverSecret;
      let seq = 0n;
      const send = async (type: ContentType, body: Uint8Array): Promise<void> => {
        const keys = await trafficKeys(SUITE, secret);
        await server.write(await sealAead(keys.key, keys.iv, seq, type, body));
        seq += 1n;
      };
      const sendKeyUpdate = async (): Promise<void> => {
        await send('handshake', keyUpdate);
        secret = await hkdfExpandLabel(SUITE, secret, 'traffic upd', new Uint8Array(0), 32);
        seq = 0n;
      };

      // Four rounds of "almost too many of each, then a byte of real data".
      // Counted over the connection's lifetime instead of consecutively, the
      // 33rd empty record — or the 5th user_canceled, or the 33rd KeyUpdate —
      // lands inside this loop and the connection dies.
      for (let round = 0; round < 4; round += 1) {
        for (let empties = 0; empties < 32; empties += 1) {
          await send('application_data', new Uint8Array(0));
        }
        for (let alerts = 0; alerts < 4; alerts += 1) {
          await send('alert', Uint8Array.of(1, 90));
        }
        for (let updates = 0; updates < 30; updates += 1) {
          await sendKeyUpdate();
        }
        await send('application_data', payload);

        expect(await connection.read()).toEqual({ ok: true, kind: 'data', bytes: payload });
      }
    });

    it('a 5th user_canceled -> unexpected_message, where 4 are ignored', async () => {
      const { connection, server, serverSecret } = await establishedConnection();
      const keys = await trafficKeys(SUITE, serverSecret);
      const userCanceled = Uint8Array.of(1, 90);
      for (let seq = 0n; seq < 5n; seq += 1n) {
        await server.write(await sealAead(keys.key, keys.iv, seq, 'alert', userCanceled));
      }
      expect(await connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });

    it('a 33rd KeyUpdate -> unexpected_message', async () => {
      const { connection, server, serverSecret } = await establishedConnection();
      const keyUpdate = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false });

      // Each KeyUpdate rotates the server's write keys, so the next one has to
      // go out under the rotated ones at sequence zero.
      let secret = serverSecret;
      for (let sent = 0; sent < 33; sent += 1) {
        const keys = await trafficKeys(SUITE, secret);
        await server.write(await sealAead(keys.key, keys.iv, 0n, 'handshake', keyUpdate));
        secret = await hkdfExpandLabel(SUITE, secret, 'traffic upd', new Uint8Array(0), 32);
      }

      expect(await connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });

    it('five KeyUpdate requests are answered once, on the next write', async () => {
      // RFC 9846 §4.7.3 requires the response and sets no deadline, so a peer
      // can have several requests in flight. Answering each one turns one cheap
      // record into a reply stream — and a peer strict about unsolicited
      // KeyUpdates drops the connection on the second.
      const { connection, server, serverSecret, clientSecret } = await establishedConnection();
      const request = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: true });

      let secret = serverSecret;
      for (let sent = 0; sent < 5; sent += 1) {
        const keys = await trafficKeys(SUITE, secret);
        await server.write(await sealAead(keys.key, keys.iv, 0n, 'handshake', request));
        secret = await hkdfExpandLabel(SUITE, secret, 'traffic upd', new Uint8Array(0), 32);
      }

      // The client only processes them while reading, so the peer's own data
      // comes last, under the keys five updates along.
      const fromServer = new TextEncoder().encode('after five updates');
      const finalKeys = await trafficKeys(SUITE, secret);
      await server.write(
        await sealAead(finalKeys.key, finalKeys.iv, 0n, 'application_data', fromServer),
      );
      expect(await connection.read()).toEqual({ ok: true, kind: 'data', bytes: fromServer });

      const payload = new TextEncoder().encode('one reply, then the data');
      const writePromise = connection.write(payload);

      const clientKeys = await trafficKeys(SUITE, clientSecret);
      expect(await openAead(clientKeys.key, clientKeys.iv, 0n, (await server.read())!)).toEqual({
        ok: true,
        type: 'handshake',
        payload: encodeHandshakeMessage({ kind: 'key_update', requestUpdate: false }),
      });

      // The very next record is the data, under the rotated keys. A second
      // KeyUpdate would land here instead.
      const rotated = await trafficKeys(
        SUITE,
        await hkdfExpandLabel(SUITE, clientSecret, 'traffic upd', new Uint8Array(0), 32),
      );
      expect(await openAead(rotated.key, rotated.iv, 0n, (await server.read())!)).toEqual({
        ok: true,
        type: 'application_data',
        payload,
      });
      expect(await writePromise).toEqual({ ok: true });
    });

    it('an alert description TLS 1.3 does not define is reported, not answered', async () => {
      // §6: "Unknown Alert types MUST be treated as error alerts." So the
      // connection ends and what the peer said is carried back — answering with
      // our own illegal_parameter threw away the only number in it.
      const { connection, server, serverSecret } = await establishedConnection();
      const keys = await trafficKeys(SUITE, serverSecret);
      // 30 is decompression_failure, which TLS 1.3 reserves and never sends.
      await server.write(await sealAead(keys.key, keys.iv, 0n, 'alert', Uint8Array.of(2, 30)));

      expect(await connection.read()).toEqual({
        ok: false,
        reason: { kind: 'alert-received-unknown', code: 30 },
      });
    });

    it("the peer's close_notify ends ITS write side, not ours", async () => {
      /**
       * RFC 9846 §6.1: "Each party MUST send a close_notify alert before closing
       * its write side of the connection... This does not have any effect on its
       * read side. Note that this is a change from versions of TLS prior to TLS
       * 1.3 in which implementations were required to react to a close_notify by
       * discarding pending writes and sending an immediate close_notify alert of
       * their own."
       *
       * One flag stood for both directions, so the peer's goodbye closed our
       * write side — and `close()` then returned early WITHOUT sending ours. A
       * peer waiting for it waited until its own timeout.
       */
      const { connection, server, serverSecret, clientSecret } = await establishedConnection();
      const serverKeys = await trafficKeys(SUITE, serverSecret);
      await server.write(
        await sealAead(serverKeys.key, serverKeys.iv, 0n, 'alert', Uint8Array.of(1, 0)),
      );

      expect(await connection.read()).toEqual({ ok: true, kind: 'closed' });
      // "Any data received after a closure alert has been received MUST be
      // ignored" — and a second read must not go looking for more.
      expect(await connection.read()).toEqual({ ok: true, kind: 'closed' });

      const payload = new TextEncoder().encode('still writing');
      const clientKeys = await trafficKeys(SUITE, clientSecret);
      expect(await connection.write(payload)).toEqual({ ok: true });
      expect(await openAead(clientKeys.key, clientKeys.iv, 0n, (await server.read())!)).toEqual({
        ok: true,
        type: 'application_data',
        payload,
      });

      expect(await connection.close()).toEqual({ ok: true });
      expect(await openAead(clientKeys.key, clientKeys.iv, 1n, (await server.read())!)).toEqual({
        ok: true,
        type: 'alert',
        payload: Uint8Array.of(1, 0),
      });
    });

    it('a post-handshake ChangeCipherSpec -> unexpected_message', async () => {
      const { connection, server } = await establishedConnection();
      await server.write(sealPlain('change_cipher_spec', Uint8Array.of(1)));
      expect(await connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });
  });

  /**
   * The shape a caller's STORE can hand back, which is not the shape the type
   * promises. Two cross-model reviews found this check running a full flight
   * too late — after `validatePath` had already been handed the corrupt value,
   * and with `reverifyOnResume: false` after the handshake had completed on the
   * wire. So what these pin is not the predicate (`session.test.ts` does that)
   * but WHERE it runs: before a single byte goes out.
   */
  describe('Gate G — a rehydrated session is checked at the door', () => {
    const storedSession = (overrides: Partial<TlsSession>): TlsSession =>
      ({
        serverName: 'mail.example.com',
        expectedPeerName: { kind: 'dns', value: 'mail.example.com' },
        suite: 'TLS_AES_128_GCM_SHA256',
        ticket: Uint8Array.of(1, 2, 3, 4),
        preSharedKey: new Uint8Array(32),
        ticketAgeAdd: 0,
        receivedAt: new Date(),
        authenticatedAt: new Date(),
        peerSignatureScheme: 'ecdsa_secp256r1_sha256',
        peerCertificateChain: { leafDer: Uint8Array.of(0x30, 0x00), intermediateDer: [] },
        lifetimeSeconds: 600,
        ...overrides,
        // `as` because the whole point is a value that lies about its type, which
        // is what a `JSON.parse` round trip produces and TypeScript cannot see.
      }) as TlsSession;

    const startWith = async (session: TlsSession) => {
      const duplex = createMemoryDuplex();
      const written: Uint8Array[] = [];
      const result = startTls({
        transport: {
          read: duplex.client.read,
          write: async bytes => {
            written.push(bytes);
            await duplex.client.write(bytes);
          },
        },
        serverName: 'mail.example.com',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date(),
        validator: {
          name: 'dummy',
          validatePath: async () => ({ ok: false, reason: { code: 'no-path-to-trust-anchor' } }),
        },
        session,
      });
      return { result, written, duplex };
    };

    it.each([
      ['lost the chain entirely', { peerCertificateChain: undefined }],
      [
        'revived the leaf as a plain object',
        { peerCertificateChain: { leafDer: { 0: 0x30 }, intermediateDer: [] } },
      ],
      ['lost the signature scheme', { peerSignatureScheme: undefined }],
    ])('throws before writing anything when a store %s', async (_case, overrides) => {
      const { result, written, duplex } = await startWith(
        storedSession(overrides as Partial<TlsSession>),
      );

      await expect(result).rejects.toThrow(/stored session/);
      // The whole point of the placement: no ClientHello, so no peer is left
      // holding a half-open handshake waiting for a Finished that never comes.
      expect(written).toEqual([]);
      duplex.close();
    });

    /**
     * The positive control. The same session with both fields intact gets past
     * the door and a ClientHello goes out — so the three above fail on the
     * rehydration check and not on anything else about this setup.
     */
    it('offers a well-formed stored session', async () => {
      const { result, written, duplex } = await startWith(storedSession({}));

      await duplex.server.read();
      expect(written.length).toBeGreaterThan(0);
      duplex.close();
      await result.catch(() => undefined);
    });
  });

  describe('Three invariants', () => {
    const runFragmentedFlight = async (
      section: '3' | '5',
      split: (allBytes: Uint8Array, prefixLen: number) => Uint8Array[],
    ) => {
      const trace = RFC_8448_TRACES.find(t => t.section === section)!;
      const inputs = extractTraceInputs(trace);
      const allServerBytes = concat(...inputs.serverRecords);
      const prefixLen = inputs.serverRecords[0]!.length + inputs.serverRecords[1]!.length;

      const duplex = createMemoryDuplex();
      const clientPromise = startTlsForReplay({
        transport: duplex.client,
        serverName: 'server',
        trustAnchors: dummyTrustAnchors,
        validationTime: new Date('2026-01-01T00:00:00Z'),
        validator: createTestValidator(inputs.serverLeafDer),
        replay: {
          clientHelloMessages: inputs.clientHellos,
          clientEphemeralPrivateKeys: inputs.clientPrivKeys,
        },
      });

      for (const chunk of split(allServerBytes, prefixLen)) {
        await duplex.server.write(chunk);
      }
      const res = await clientPromise;
      expect(res.ok).toBe(true);
    };

    it('8.1 Fragmentation is invisible', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs3 = extractTraceInputs(trace3);
      const all3 = concat(...inputs3.serverRecords);

      // (a) all records as one coalesced chunk — §3 and §5
      await runFragmentedFlight('3', bytes => [bytes]);
      await runFragmentedFlight('5', bytes => [bytes]);

      // Every short-prefix offset for the first two records (§3 and §5)
      for (const section of ['3', '5'] as const) {
        const trace = RFC_8448_TRACES.find(t => t.section === section)!;
        const inputs = extractTraceInputs(trace);
        const allBytes = concat(...inputs.serverRecords);
        const prefixLen = inputs.serverRecords[0]!.length + inputs.serverRecords[1]!.length;
        for (let offset = 1; offset < prefixLen; offset += 1) {
          await runFragmentedFlight(section, (bytes, prefix) => {
            void prefix;
            return [bytes.subarray(0, offset), bytes.subarray(offset)];
          });
        }
        // 32 fixed-seed offsets across the whole flight
        let seed = section === '3' ? 0x12345678 : 0x87654321;
        const next = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return seed;
        };
        const offsets = Array.from({ length: 32 }, () => 1 + (next() % (allBytes.length - 1)))
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .sort((a, b) => a - b);
        await runFragmentedFlight(section, bytes => {
          const chunks: Uint8Array[] = [];
          let prev = 0;
          for (const off of offsets) {
            chunks.push(bytes.subarray(prev, off));
            prev = off;
          }
          chunks.push(bytes.subarray(prev));
          return chunks;
        });
      }

      // (b) §3 handshake payload re-sealed across three records
      {
        expect(inputs3.serverHsWriteKey).toBeDefined();
        expect(inputs3.serverHsWriteIv).toBeDefined();
        const openFlight = await openAead(
          inputs3.serverHsWriteKey!,
          inputs3.serverHsWriteIv!,
          0n,
          inputs3.serverRecords[1]!,
        );
        expect(openFlight.ok).toBe(true);
        if (!openFlight.ok) return;
        expect(openFlight.payload.length).toBe(657);
        const p = openFlight.payload;
        const third = Math.floor(p.length / 3);
        const pieces = [p.subarray(0, third), p.subarray(third, third * 2), p.subarray(third * 2)];
        const resealed: Uint8Array[] = [];
        for (let i = 0; i < pieces.length; i += 1) {
          resealed.push(
            await sealAead(
              inputs3.serverHsWriteKey!,
              inputs3.serverHsWriteIv!,
              BigInt(i),
              'handshake',
              pieces[i]!,
            ),
          );
        }

        const duplex = createMemoryDuplex();
        const clientPromise = startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs3.serverLeafDer),
          replay: {
            clientHelloMessages: inputs3.clientHellos,
            clientEphemeralPrivateKeys: inputs3.clientPrivKeys,
          },
        });
        await duplex.server.write(inputs3.serverRecords[0]!);
        for (const rec of resealed) await duplex.server.write(rec);
        for (let i = 2; i < inputs3.serverRecords.length; i += 1) {
          await duplex.server.write(inputs3.serverRecords[i]!);
        }
        expect((await clientPromise).ok).toBe(true);
      }

      // Silence unused
      expect(all3.length).toBeGreaterThan(0);
    }, 30_000);

    it('8.2 (key, nonce) is globally unique including KeyUpdate', async () => {
      const recordedEvents: AeadRecordEvent[] = [];
      setAeadObserver(event => {
        recordedEvents.push(event);
      });

      try {
        const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
        const inputs = extractTraceInputs(trace3);
        const duplex = createMemoryDuplex();

        const peerFeed = async () => {
          // Omit close_notify so we can inject KeyUpdate after app data
          for (const rec of inputs.serverRecords.slice(0, 4)) {
            await duplex.server.write(rec);
          }
        };

        const [clientResult] = await Promise.all([
          startTlsForReplay({
            transport: duplex.client,
            serverName: 'server',
            trustAnchors: dummyTrustAnchors,
            validationTime: new Date('2026-01-01T00:00:00Z'),
            validator: createTestValidator(inputs.serverLeafDer),
            replay: {
              clientHelloMessages: inputs.clientHellos,
              clientEphemeralPrivateKeys: inputs.clientPrivKeys,
            },
          }),
          peerFeed(),
        ]);

        expect(clientResult.ok).toBe(true);
        if (!clientResult.ok) return;

        const conn = clientResult.connection;
        await conn.read();

        const s_ap = bytesOf(
          trace3.steps.find(s => s.title === 'derive secret "tls13 s ap traffic"')!,
          'expanded',
        )!;
        const currentServerKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', s_ap);
        const kuMsg = encodeHandshakeMessage({ kind: 'key_update', requestUpdate: true });
        await duplex.server.write(
          await sealAead(currentServerKeys.key, currentServerKeys.iv, 2n, 'handshake', kuMsg),
        );

        // Concurrent writes while KeyUpdate is processed
        const writePromises = [
          conn.write(new TextEncoder().encode('w0')),
          conn.write(new TextEncoder().encode('w1')),
          conn.write(new TextEncoder().encode('w2')),
        ];
        // Drive the read loop so KeyUpdate is handled interleaved with writes
        const newServerSecret = await hkdfExpandLabel(
          'TLS_AES_128_GCM_SHA256',
          s_ap,
          'traffic upd',
          new Uint8Array(0),
          32,
        );
        const newServerKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', newServerSecret);
        await duplex.server.write(
          await sealAead(
            newServerKeys.key,
            newServerKeys.iv,
            0n,
            'application_data',
            new TextEncoder().encode('after'),
          ),
        );
        await conn.read();
        await Promise.all(writePromises);
        await conn.close();

        // Identity is (key, nonce) among seals — direction must not hide reuse.
        // Opens are excluded: the test harness seals peer records that the client
        // then opens under the same (key, nonce).
        const seen = new Set<string>();
        for (const ev of recordedEvents) {
          if (ev.direction !== 'seal') continue;
          const keyHex = Array.from(ev.key)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
          const nonceHex = Array.from(ev.nonce)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
          const id = `${keyHex}:${nonceHex}`;
          expect(seen.has(id)).toBe(false);
          seen.add(id);
        }
      } finally {
        setAeadObserver(null);
      }
    });

    it('8.3 A corrupted byte never yields plaintext', async () => {
      const trace3 = RFC_8448_TRACES.find(t => t.section === '3')!;
      const inputs = extractTraceInputs(trace3);
      const serverEncryptedRecord = inputs.serverRecords[1]!;
      const clientFinishedRecord = inputs.publishedClientHandshakeRecords[1]!;
      expect(serverEncryptedRecord.length).toBe(679);
      expect(clientFinishedRecord.length).toBe(58);

      const assertFailClosed = async (mutate: (records: Uint8Array[]) => void) => {
        const duplex = createMemoryDuplex();
        const records = inputs.serverRecords.map(r => new Uint8Array(r));
        mutate(records);
        const clientPromise = startTlsForReplay({
          transport: duplex.client,
          serverName: 'server',
          trustAnchors: dummyTrustAnchors,
          validationTime: new Date('2026-01-01T00:00:00Z'),
          validator: createTestValidator(inputs.serverLeafDer),
          replay: {
            clientHelloMessages: inputs.clientHellos,
            clientEphemeralPrivateKeys: inputs.clientPrivKeys,
          },
        });
        for (const rec of records) {
          await duplex.server.write(rec);
        }
        const res = await clientPromise;
        // For client-Finished corruption the handshake succeeds; corruption is checked
        // by opening through the public reader after connect. Those cases return below.
        return { res, duplex };
      };

      // Every byte of §3's first encrypted server record through the public SM
      for (let i = 0; i < serverEncryptedRecord.length; i += 1) {
        const { res } = await assertFailClosed(records => {
          records[1]![i]! ^= 0x01;
        });
        expect(res.ok).toBe(false);
        if (!res.ok && (res.reason.kind === 'alert-sent' || res.reason.kind === 'alert-received')) {
          expect([
            'bad_record_mac',
            'decode_error',
            'record_overflow',
            'unexpected_message',
          ]).toContain(res.reason.alert.description);
        }
      }

      // Every byte of §3's client Finished: seal/open via public path by feeding a peer
      // that completes handshake, then verifying openAead rejects each flipped finished.
      expect(inputs.clientHsWriteKey).toBeDefined();
      expect(inputs.clientHsWriteIv).toBeDefined();
      for (let i = 0; i < clientFinishedRecord.length; i += 1) {
        const tampered = new Uint8Array(clientFinishedRecord);
        tampered[i]! ^= 0x01;
        const opened = await openAead(
          inputs.clientHsWriteKey!,
          inputs.clientHsWriteIv!,
          0n,
          tampered,
        );
        expect(opened.ok).toBe(false);
      }
    }, 30_000);
  });
});
