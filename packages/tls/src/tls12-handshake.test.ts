import {
  type IssuedCertificate,
  issueCertificate,
  SERVER_AUTH,
  type TrustAnchorSource,
  type Validator,
  YOZZ_VALIDATOR,
} from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { type AlertDescription, decodeAlert } from './alert.ts';
import { concat, writeUint8, writeUint16 } from './bytes.ts';
import { type HandshakeResult, type StartTlsOptions, startTls } from './handshake.ts';
import {
  decodeHandshakeMessage,
  decodeTls12HandshakeMessage,
  type Extension,
  encodeHandshakeMessage,
  encodeTls12HandshakeMessage,
  type HandshakeMessage,
} from './handshake-messages.ts';
import {
  CIPHER_SUITES,
  deriveSecret,
  earlySecret,
  finishedKey,
  handshakeSecret,
  trafficKeys,
  verifyData,
} from './key-schedule.ts';
import { deriveSharedSecret, generateKeyShare } from './key-share.ts';
import {
  openPlain,
  openTls12Aead,
  RecordReader,
  sealAead,
  sealPlain,
  sealTls12Aead,
} from './record.ts';
import {
  type Tls12KeyBlock,
  tls12ExtendedMasterSecret,
  tls12KeyBlock,
  tls12MasterSecret,
  tls12TranscriptHash,
  tls12VerifyData,
} from './tls12-key-schedule.ts';
import { type ByteDuplex, createMemoryDuplex } from './transport.ts';
import {
  DOWNGRADE_SENTINEL_TLS_1_1,
  DOWNGRADE_SENTINEL_TLS_1_2,
  HRR_MAGIC_RANDOM,
  NAMED_GROUPS,
  type NamedGroup,
  TLS_1_2_CIPHER_SUITES,
  TLS_1_2_SIGNATURE_SCHEMES,
  TLS_VERSION,
  type Tls12CipherSuite,
  type Tls12SignatureScheme,
  type TlsProtocolVersion,
} from './wire.ts';

const SERVER_NAME = 'mail.example.com';

const encodeDerInteger = (bytes: Uint8Array): Uint8Array => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  const content = (trimmed[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed;
  return concat(Uint8Array.of(0x02, content.length), content);
};

const p1363ToDer = (signature: Uint8Array, scalarLength: number): Uint8Array => {
  const r = encodeDerInteger(signature.subarray(0, scalarLength));
  const s = encodeDerInteger(signature.subarray(scalarLength));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
};

const generateRsaKeyPair = (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );

const generateEcKeyPair = (namedCurve: 'P-256' | 'P-384'): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, ['sign', 'verify']);

type IssuedFixture = {
  readonly root: IssuedCertificate;
  readonly leaf: IssuedCertificate;
  readonly trustAnchors: TrustAnchorSource;
};

const makeFixture = async (keyPair?: CryptoKeyPair): Promise<IssuedFixture> => {
  const root = await issueCertificate({ commonName: 'yozz test root', isCa: true });
  const leaf = await issueCertificate({
    commonName: SERVER_NAME,
    issuer: root,
    dnsNames: [SERVER_NAME],
    extendedKeyUsages: [SERVER_AUTH],
    keyPair,
  });
  return {
    root,
    leaf,
    trustAnchors: {
      findCandidates: () => [
        { id: 'yozz-test-root', certificateDer: root.der, serverDistrustAfter: null },
      ],
    },
  };
};

const signServerParams = async (
  privateKey: CryptoKey,
  scheme: Tls12SignatureScheme,
  clientRandom: Uint8Array,
  serverRandom: Uint8Array,
  serverParams: Uint8Array,
): Promise<Uint8Array> => {
  const data = new Uint8Array(concat(clientRandom, serverRandom, serverParams));
  if (scheme === 'ecdsa_secp256r1_sha256') {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data),
    );
    return p1363ToDer(raw, raw.length / 2);
  }
  if (scheme === 'ecdsa_secp384r1_sha384') {
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, privateKey, data),
    );
    return p1363ToDer(raw, raw.length / 2);
  }
  if (scheme === 'rsa_pkcs1_sha256') {
    return new Uint8Array(
      await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, data),
    );
  }
  if (scheme === 'rsa_pss_rsae_sha256') {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
    const pssKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(
      await crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 32 }, pssKey, data),
    );
  }
  throw new Error(`Unsupported scripted test signing scheme: ${scheme}`);
};

type ScriptedServerConfig = {
  readonly fixture: IssuedFixture;
  readonly suite?: Tls12CipherSuite;
  readonly rawCipherSuiteCode?: number;
  readonly group?: NamedGroup;
  readonly rawSkeCurveCode?: number;
  readonly skePublicKeyOverride?: Uint8Array;
  readonly scheme?: Tls12SignatureScheme;
  readonly rawSkeSchemeCode?: number;
  readonly tamperSkeSignature?: boolean;
  readonly serverRandom?: Uint8Array;
  readonly echoClientSessionId?: boolean;
  readonly extensions?: readonly Extension[];
  readonly omitExtendedMasterSecret?: boolean;
  readonly emptyServerCertificate?: boolean;
  readonly sendCertificateRequest?: boolean;
  readonly sendDuplicateCertificateRequest?: boolean;
  readonly coalesceServerFlight?: boolean;
  readonly fragmentServerFlight?: boolean;
  readonly fragmentServerFinished?: boolean;
  readonly trailingBytesAfterShd?: Uint8Array;
  readonly trailingBytesAfterFinished?: Uint8Array;
  readonly prematureRecordBeforeShd?: Uint8Array;
  readonly malformedServerCcs?: Uint8Array;
  readonly tamperServerFinished?: boolean;
  readonly preServerHelloRecords?: readonly Uint8Array[];
  readonly omitCertificateSendUnsignedSke?: boolean;
};

type ScriptedTls12Session = {
  readonly suite: Tls12CipherSuite;
  readonly keys: Tls12KeyBlock;
  readonly masterSecret: Uint8Array;
  readonly clientRandom: Uint8Array;
  readonly serverRandom: Uint8Array;
  readonly reader: RecordReader;
  readonly serverDuplex: ByteDuplex;
  clientReadSeq: bigint;
  serverWriteSeq: bigint;
};

const readSingleHandshakeFrom = async (reader: RecordReader): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  while (true) {
    const rec = await reader.readRecord();
    if (!rec.ok || rec.kind !== 'record') throw new Error('unexpected EOF reading client record');
    const plain = openPlain(rec.record);
    if (!plain.ok || plain.type !== 'handshake') throw new Error('expected plaintext handshake');
    chunks.push(plain.payload);
    const all = concat(...chunks);
    if (all.length >= 4) {
      const len = (all[1]! << 16) | (all[2]! << 8) | all[3]!;
      if (all.length >= 4 + len) return all.subarray(0, 4 + len);
    }
  }
};

const runScriptedTls12 = async (
  config: ScriptedServerConfig,
  clientOptions: Partial<StartTlsOptions> = {},
): Promise<{
  readonly result: HandshakeResult;
  readonly session?: ScriptedTls12Session;
  readonly lastClientRecord?: Uint8Array;
  readonly clientKeys?: Tls12KeyBlock;
}> => {
  const duplex = createMemoryDuplex();
  const suite: Tls12CipherSuite = config.suite ?? 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256';
  const group: NamedGroup = config.group ?? 'x25519';
  const scheme: Tls12SignatureScheme = config.scheme ?? 'ecdsa_secp256r1_sha256';
  const serverRandom = config.serverRandom ?? crypto.getRandomValues(new Uint8Array(32));
  const useEms = !config.omitExtendedMasterSecret;

  let establishedSession: ScriptedTls12Session | undefined;
  let lastClientRecord: Uint8Array | undefined;
  let derivedKeys: Tls12KeyBlock | undefined;

  const clientPromise = startTls({
    transport: duplex.client,
    serverName: SERVER_NAME,
    trustAnchors: config.fixture.trustAnchors,
    validationTime: Temporal.Now.instant(),
    validator: YOZZ_VALIDATOR,
    ...clientOptions,
  });

  const serverPromise = (async () => {
    const reader = new RecordReader(() => duplex.server.read());
    const chBytes = await readSingleHandshakeFrom(reader);
    const chDecoded = decodeHandshakeMessage(chBytes);
    if (!chDecoded.ok || chDecoded.value.kind !== 'client_hello') {
      throw new Error('expected ClientHello');
    }
    const clientRandom = chDecoded.value.random;
    const transcript: Uint8Array[] = [chBytes];

    const defaultExtensions: Extension[] = [
      { kind: 'renegotiation_info', renegotiatedConnection: new Uint8Array(0) },
      { kind: 'ec_point_formats', formats: [0] },
      ...(useEms ? ([{ kind: 'extended_master_secret' }] as const) : []),
    ];
    const extensions = config.extensions ?? defaultExtensions;

    const shBytes = encodeHandshakeMessage({
      kind: 'server_hello',
      legacyVersion: TLS_VERSION.V1_2,
      random: serverRandom,
      legacySessionIdEcho: config.echoClientSessionId
        ? chDecoded.value.legacySessionId
        : new Uint8Array(0),
      cipherSuite: config.rawCipherSuiteCode ?? TLS_1_2_CIPHER_SUITES[suite].code,
      legacyCompressionMethod: 0,
      extensions,
    });
    transcript.push(shBytes);

    const serverShare = await generateKeyShare(group);
    const skePublicKey = config.skePublicKeyOverride ?? serverShare.publicKey;
    const skeCurveCode = config.rawSkeCurveCode ?? NAMED_GROUPS[group];
    const serverParams = concat(
      writeUint8(3),
      writeUint16(skeCurveCode),
      writeUint8(skePublicKey.length),
      skePublicKey,
    );
    const rawSig = await signServerParams(
      config.fixture.leaf.keyPair.privateKey,
      scheme,
      clientRandom,
      serverRandom,
      serverParams,
    );
    const signature = new Uint8Array(rawSig);
    if (config.tamperSkeSignature) {
      signature[signature.length - 1]! ^= 0xff;
    }

    const certBytes = encodeTls12HandshakeMessage({
      kind: 'certificate',
      certificateList: config.emptyServerCertificate ? [] : [config.fixture.leaf.der],
    });
    const skeBytes = encodeTls12HandshakeMessage({
      kind: 'server_key_exchange',
      curveType: 3,
      namedCurve: skeCurveCode,
      publicKey: skePublicKey,
      serverParams,
      scheme: config.rawSkeSchemeCode ?? TLS_1_2_SIGNATURE_SCHEMES[scheme],
      signature,
    });
    const certReqBytes = encodeTls12HandshakeMessage({
      kind: 'certificate_request',
      certificateTypes: [1, 64],
      signatureSchemes: [0x0403, 0x0401],
      rawAuthorities: new Uint8Array(0),
    });
    const shdBytes = encodeTls12HandshakeMessage({ kind: 'server_hello_done' });

    const flightMessages: Uint8Array[] = [shBytes, certBytes, skeBytes];
    transcript.push(certBytes, skeBytes);
    if (config.sendCertificateRequest || config.sendDuplicateCertificateRequest) {
      flightMessages.push(certReqBytes);
      transcript.push(certReqBytes);
    }
    if (config.sendDuplicateCertificateRequest) {
      flightMessages.push(certReqBytes);
    }
    flightMessages.push(shdBytes);
    transcript.push(shdBytes);
    if (config.trailingBytesAfterShd !== undefined) {
      flightMessages.push(config.trailingBytesAfterShd);
    }

    if (config.preServerHelloRecords !== undefined) {
      for (const record of config.preServerHelloRecords) {
        await duplex.server.write(record);
      }
    }

    if (config.omitCertificateSendUnsignedSke) {
      const unsignedSke = concat(
        writeUint8(12),
        writeUint8(0),
        writeUint16(serverParams.length),
        serverParams,
      );
      await duplex.server.write(sealPlain('handshake', shBytes));
      await duplex.server.write(sealPlain('handshake', unsignedSke));
      return;
    }

    if (config.prematureRecordBeforeShd !== undefined) {
      await duplex.server.write(sealPlain('handshake', shBytes));
      await duplex.server.write(sealPlain('handshake', certBytes));
      await duplex.server.write(sealPlain('handshake', skeBytes));
      await duplex.server.write(config.prematureRecordBeforeShd);
      return;
    }

    if (config.coalesceServerFlight) {
      await duplex.server.write(sealPlain('handshake', concat(...flightMessages)));
    } else if (config.fragmentServerFlight) {
      const combined = concat(...flightMessages);
      for (let at = 0; at < combined.length; at += 17) {
        await duplex.server.write(sealPlain('handshake', combined.subarray(at, at + 17)));
      }
    } else {
      for (const msg of flightMessages) {
        await duplex.server.write(sealPlain('handshake', msg));
      }
    }

    // Read client's flight (or fatal alert if client rejected our flight).
    const firstClientRec = await reader.readRecord();
    if (!firstClientRec.ok || firstClientRec.kind !== 'record') return;
    lastClientRecord = firstClientRec.record;
    const firstPlain = openPlain(firstClientRec.record);
    if (!firstPlain.ok || firstPlain.type !== 'handshake') return;

    let ckeBytes: Uint8Array;
    if (config.sendCertificateRequest) {
      const clientCertBytes = firstPlain.payload;
      const decodedClientCert = decodeTls12HandshakeMessage(clientCertBytes);
      if (
        !decodedClientCert.ok ||
        decodedClientCert.value.kind !== 'certificate' ||
        decodedClientCert.value.certificateList.length !== 0
      ) {
        throw new Error('expected empty TLS 1.2 client Certificate');
      }
      transcript.push(clientCertBytes);
      const nextRec = await reader.readRecord();
      if (!nextRec.ok || nextRec.kind !== 'record') return;
      const nextPlain = openPlain(nextRec.record);
      if (!nextPlain.ok || nextPlain.type !== 'handshake') return;
      ckeBytes = nextPlain.payload;
    } else {
      ckeBytes = firstPlain.payload;
    }

    const decodedCke = decodeTls12HandshakeMessage(ckeBytes);
    if (!decodedCke.ok || decodedCke.value.kind !== 'client_key_exchange') {
      throw new Error('expected ClientKeyExchange');
    }
    transcript.push(ckeBytes);

    const premaster = await deriveSharedSecret(
      group,
      serverShare.privateKey,
      decodedCke.value.publicKey,
    );
    const hasEms = extensions.some(e => e.kind === 'extended_master_secret');
    const hashBeforeClientFin = await tls12TranscriptHash(suite, ...transcript);
    const masterSecret = hasEms
      ? await tls12ExtendedMasterSecret(suite, premaster, hashBeforeClientFin)
      : await tls12MasterSecret(suite, premaster, clientRandom, serverRandom);
    const keys = await tls12KeyBlock(suite, masterSecret, clientRandom, serverRandom);
    derivedKeys = keys;

    // Client CCS
    const ccsRec = await reader.readRecord();
    if (!ccsRec.ok || ccsRec.kind !== 'record') return;
    const ccsPlain = openPlain(ccsRec.record);
    if (!ccsPlain.ok || ccsPlain.type !== 'change_cipher_spec') {
      throw new Error('expected client CCS');
    }

    // Client Finished
    const clientFinRec = await reader.readRecord();
    if (!clientFinRec.ok || clientFinRec.kind !== 'record') return;
    const openedClientFin = await openTls12Aead(
      keys.clientWriteKey,
      keys.clientWriteIv,
      0n,
      clientFinRec.record,
    );
    if (!openedClientFin.ok || openedClientFin.type !== 'handshake') {
      throw new Error('failed to open client Finished');
    }
    transcript.push(openedClientFin.payload);

    // Server CCS
    if (config.malformedServerCcs !== undefined) {
      await duplex.server.write(sealPlain('change_cipher_spec', config.malformedServerCcs));
      const alertRec = await reader.readRecord();
      if (alertRec.ok && alertRec.kind === 'record') lastClientRecord = alertRec.record;
      return;
    }
    await duplex.server.write(sealPlain('change_cipher_spec', Uint8Array.of(1)));

    // Server Finished
    const serverFinHash = await tls12TranscriptHash(suite, ...transcript);
    const serverVerifyData = new Uint8Array(
      await tls12VerifyData(suite, masterSecret, 'server', serverFinHash),
    );
    if (config.tamperServerFinished) {
      serverVerifyData[0]! ^= 0x80;
    }
    const serverFinPayload = concat(
      encodeTls12HandshakeMessage({ kind: 'finished', verifyData: serverVerifyData }),
      ...(config.trailingBytesAfterFinished === undefined
        ? []
        : [config.trailingBytesAfterFinished]),
    );

    let serverWriteSeq = 0n;
    if (config.fragmentServerFinished) {
      const split = 6;
      await duplex.server.write(
        await sealTls12Aead(
          keys.serverWriteKey,
          keys.serverWriteIv,
          serverWriteSeq,
          'handshake',
          serverFinPayload.subarray(0, split),
        ),
      );
      serverWriteSeq += 1n;
      await duplex.server.write(
        await sealTls12Aead(
          keys.serverWriteKey,
          keys.serverWriteIv,
          serverWriteSeq,
          'handshake',
          serverFinPayload.subarray(split),
        ),
      );
      serverWriteSeq += 1n;
    } else {
      await duplex.server.write(
        await sealTls12Aead(
          keys.serverWriteKey,
          keys.serverWriteIv,
          serverWriteSeq,
          'handshake',
          serverFinPayload,
        ),
      );
      serverWriteSeq += 1n;
    }

    if (config.tamperServerFinished || config.trailingBytesAfterFinished !== undefined) {
      const alertRec = await reader.readRecord();
      if (alertRec.ok && alertRec.kind === 'record') lastClientRecord = alertRec.record;
      return;
    }

    establishedSession = {
      suite,
      keys,
      masterSecret,
      clientRandom,
      serverRandom,
      reader,
      serverDuplex: duplex.server,
      clientReadSeq: 1n,
      serverWriteSeq,
    };
  })();

  const [result] = await Promise.all([clientPromise, serverPromise]);
  return { result, session: establishedSession, lastClientRecord, clientKeys: derivedKeys };
};

const alertOf = (result: HandshakeResult): AlertDescription | undefined => {
  if (result.ok) return undefined;
  if (result.reason.kind === 'alert-sent' || result.reason.kind === 'alert-received') {
    return result.reason.alert.description;
  }
  return undefined;
};

describe('TLS 1.2 handshake state machine & security boundaries', () => {
  it('completes a non-EMS TLS 1.2 handshake using the RFC 5246 master secret', async () => {
    const fixture = await makeFixture();
    const { result, session } = await runScriptedTls12({
      fixture,
      omitExtendedMasterSecret: true,
    });
    expect(result).toMatchObject({
      ok: true,
      protocolVersion: 'TLS 1.2',
      negotiatedGroup: 'x25519',
      isResumed: false,
      isHelloRetryRequested: false,
      peerSignatureScheme: 'ecdsa_secp256r1_sha256',
    });
    if (!result.ok || session === undefined) return;

    const payload = new TextEncoder().encode('non-ems-app-data');
    await session.serverDuplex.write(
      await sealTls12Aead(
        session.keys.serverWriteKey,
        session.keys.serverWriteIv,
        session.serverWriteSeq,
        'application_data',
        payload,
      ),
    );
    expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: payload });
  });

  it('handles coalesced ServerHello+Certificate+SKE+SHD in a single plaintext record', async () => {
    const fixture = await makeFixture();
    const { result } = await runScriptedTls12({
      fixture,
      coalesceServerFlight: true,
    });
    expect(result).toMatchObject({ ok: true, protocolVersion: 'TLS 1.2' });
  });

  it('handles fragmented plaintext handshake records and fragmented encrypted Finished', async () => {
    const fixture = await makeFixture();
    const { result } = await runScriptedTls12({
      fixture,
      fragmentServerFlight: true,
      fragmentServerFinished: true,
    });
    expect(result).toMatchObject({ ok: true, protocolVersion: 'TLS 1.2' });
  });

  it('handles CertificateRequest and rejects a duplicate CertificateRequest', async () => {
    const fixture = await makeFixture();
    const okRun = await runScriptedTls12({ fixture, sendCertificateRequest: true });
    expect(okRun.result).toMatchObject({ ok: true, protocolVersion: 'TLS 1.2' });

    const dupRun = await runScriptedTls12({ fixture, sendDuplicateCertificateRequest: true });
    expect(alertOf(dupRun.result)).toBe('unexpected_message');
  });

  describe('RFC 9846 §4.2.3 downgrade sentinels & version policy', () => {
    it('rejects DOWNGRADE_SENTINEL_TLS_1_2 when maxVersion is TLS 1.3', async () => {
      const fixture = await makeFixture();
      const random = new Uint8Array(32);
      random.set(DOWNGRADE_SENTINEL_TLS_1_2, 24);
      const { result } = await runScriptedTls12({ fixture, serverRandom: random });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects DOWNGRADE_SENTINEL_TLS_1_1 when maxVersion is TLS 1.3', async () => {
      const fixture = await makeFixture();
      const random = new Uint8Array(32);
      random.set(DOWNGRADE_SENTINEL_TLS_1_1, 24);
      const { result } = await runScriptedTls12({ fixture, serverRandom: random });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('permits DOWNGRADE_SENTINEL_TLS_1_2 when maxVersion is TLS 1.2', async () => {
      const fixture = await makeFixture();
      const random = new Uint8Array(32);
      random.set(DOWNGRADE_SENTINEL_TLS_1_2, 24);
      const { result } = await runScriptedTls12(
        { fixture, serverRandom: random },
        { maxVersion: 'TLS 1.2' },
      );
      expect(result).toMatchObject({ ok: true, protocolVersion: 'TLS 1.2' });
    });

    it('throws before writing a byte when minVersion is TLS 1.3 and maxVersion is TLS 1.2', async () => {
      const fixture = await makeFixture();
      const duplex = createMemoryDuplex();
      const written: Uint8Array[] = [];
      await expect(
        startTls({
          transport: {
            read: duplex.client.read,
            write: async bytes => {
              written.push(bytes);
              await duplex.client.write(bytes);
            },
          },
          serverName: SERVER_NAME,
          trustAnchors: fixture.trustAnchors,
          validationTime: Temporal.Now.instant(),
          validator: YOZZ_VALIDATOR,
          minVersion: 'TLS 1.3',
          maxVersion: 'TLS 1.2',
        }),
      ).rejects.toThrow(/minVersion/);
      expect(written).toEqual([]);
    });

    it('rejects a TLS 1.2 ServerHello with protocol_version when minVersion is TLS 1.3', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({ fixture }, { minVersion: 'TLS 1.3' });
      expect(alertOf(result)).toBe('protocol_version');
    });

    it('rejects supported_versions in ServerHello with unsupported_extension when maxVersion is TLS 1.2', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12(
        {
          fixture,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          ],
        },
        { maxVersion: 'TLS 1.2' },
      );
      expect(alertOf(result)).toBe('unsupported_extension');
    });

    it('rejects dropping from a TLS 1.3 HelloRetryRequest to TLS 1.2 with illegal_parameter', async () => {
      const fixture = await makeFixture();
      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: SERVER_NAME,
        trustAnchors: fixture.trustAnchors,
        validationTime: Temporal.Now.instant(),
        validator: YOZZ_VALIDATOR,
      });

      const ch1Plain = openPlain((await duplex.server.read())!);
      if (!ch1Plain.ok) throw new Error('ch1');
      const ch1 = decodeHandshakeMessage(ch1Plain.payload);
      if (!ch1.ok || ch1.value.kind !== 'client_hello') throw new Error('ch1');

      const hrr: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: TLS_VERSION.V1_2,
        random: HRR_MAGIC_RANDOM,
        legacySessionIdEcho: ch1.value.legacySessionId,
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          { kind: 'key_share', selectedGroup: NAMED_GROUPS.secp256r1 },
        ],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(hrr)));
      await duplex.server.read(); // CCS
      const ch2Rec = await duplex.server.read();
      const ch2Plain = openPlain(ch2Rec!);
      if (!ch2Plain.ok) throw new Error('ch2');
      const ch2 = decodeHandshakeMessage(ch2Plain.payload);
      if (!ch2.ok || ch2.value.kind !== 'client_hello') throw new Error('ch2');
      // RFC 9846 §4.2.4: CH2 preserves CH1's version & TLS 1.2 offers.
      expect(ch2.value.cipherSuites).toEqual(ch1.value.cipherSuites);
      expect(ch2.value.extensions.find(e => e.kind === 'supported_versions')).toEqual({
        kind: 'supported_versions',
        versions: [TLS_VERSION.V1_3, TLS_VERSION.V1_2],
        isServerHello: false,
      });

      // Now attempt a TLS 1.2 ServerHello after the HRR.
      const sh12: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: TLS_VERSION.V1_2,
        random: crypto.getRandomValues(new Uint8Array(32)),
        legacySessionIdEcho: new Uint8Array(0),
        cipherSuite: 0xc02b,
        legacyCompressionMethod: 0,
        extensions: [],
      };
      await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh12)));
      expect(alertOf(await clientPromise)).toBe('illegal_parameter');
    });
  });

  describe('TLS 1.2 cipher suite, auth, SKE, and extension checks', () => {
    it('rejects a TLS 1.3 or CBC cipher suite in a TLS 1.2 ServerHello with illegal_parameter', async () => {
      const fixture = await makeFixture();
      for (const rawCipherSuiteCode of [0x1301, 0xc023]) {
        const { result } = await runScriptedTls12({ fixture, rawCipherSuiteCode });
        expect(alertOf(result)).toBe('illegal_parameter');
      }
    });

    it('rejects RSA cipher suite paired with an ECDSA leaf certificate', async () => {
      const ecFixture = await makeFixture(await generateEcKeyPair('P-256'));
      const { result } = await runScriptedTls12({
        fixture: ecFixture,
        suite: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects ECDSA cipher suite paired with an RSA leaf certificate', async () => {
      const rsaFixture = await makeFixture(await generateRsaKeyPair());
      const { result } = await runScriptedTls12({
        fixture: rsaFixture,
        suite: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
        scheme: 'rsa_pkcs1_sha256',
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects an unoffered signature scheme in ServerKeyExchange with illegal_parameter', async () => {
      const rsaFixture = await makeFixture(await generateRsaKeyPair());
      const { result } = await runScriptedTls12(
        {
          fixture: rsaFixture,
          suite: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
          scheme: 'rsa_pkcs1_sha256',
        },
        { signatureSchemes: ['rsa_pss_rsae_sha256'] },
      );
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects an unoffered curve in ServerKeyExchange with illegal_parameter', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12(
        { fixture, group: 'secp384r1' },
        { supportedGroups: ['x25519', 'secp256r1'] },
      );
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects a compressed or wrong-length point in ServerKeyExchange with illegal_parameter', async () => {
      const fixture = await makeFixture();
      const compressed = new Uint8Array(65);
      compressed[0] = 0x02;
      const { result } = await runScriptedTls12({
        fixture,
        group: 'secp256r1',
        skePublicKeyOverride: compressed,
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects a tampered ServerKeyExchange signature with decrypt_error', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        tamperSkeSignature: true,
      });
      expect(alertOf(result)).toBe('decrypt_error');
    });

    it('rejects an echoed non-empty legacySessionId in TLS 1.2 ServerHello with illegal_parameter', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        echoClientSessionId: true,
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects non-empty renegotiation_info in TLS 1.2 ServerHello with handshake_failure', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        extensions: [{ kind: 'renegotiation_info', renegotiatedConnection: Uint8Array.of(1, 2) }],
      });
      expect(alertOf(result)).toBe('handshake_failure');
    });

    it('rejects ec_point_formats without uncompressed (0) with illegal_parameter', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        extensions: [{ kind: 'ec_point_formats', formats: [1] }],
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('rejects non-empty server_name in TLS 1.2 ServerHello with decode_error', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        extensions: [{ kind: 'server_name', serverNames: [SERVER_NAME] }],
      });
      expect(alertOf(result)).toBe('decode_error');
    });

    it('rejects unoffered extensions and TLS 1.3-only key_share in TLS 1.2 ServerHello', async () => {
      const fixture = await makeFixture();
      const unoffered = await runScriptedTls12({
        fixture,
        extensions: [{ kind: 'unknown', typeCode: 0xabcd, data: new Uint8Array(0) }],
      });
      expect(alertOf(unoffered.result)).toBe('unsupported_extension');

      // When TLS 1.3 was offered, key_share WAS offered so in a TLS 1.2 SH it is illegal_parameter.
      const ksOnDual = await runScriptedTls12({
        fixture,
        extensions: [
          {
            kind: 'key_share',
            serverShare: { group: NAMED_GROUPS.x25519, keyExchange: new Uint8Array(32) },
          },
        ],
      });
      expect(alertOf(ksOnDual.result)).toBe('illegal_parameter');

      // When TLS 1.2-only, key_share was NEVER offered so it is unsupported_extension.
      const ksOn12Only = await runScriptedTls12(
        {
          fixture,
          extensions: [
            {
              kind: 'key_share',
              serverShare: { group: NAMED_GROUPS.x25519, keyExchange: new Uint8Array(32) },
            },
          ],
        },
        { maxVersion: 'TLS 1.2' },
      );
      expect(alertOf(ksOn12Only.result)).toBe('unsupported_extension');
    });

    it('rejects empty server Certificate, premature CCS/app_data, trailing bytes, malformed CCS, and bad server Finished', async () => {
      const fixture = await makeFixture();

      expect(
        alertOf((await runScriptedTls12({ fixture, emptyServerCertificate: true })).result),
      ).toBe('decode_error');
      expect(
        alertOf(
          (
            await runScriptedTls12({
              fixture,
              prematureRecordBeforeShd: sealPlain('change_cipher_spec', Uint8Array.of(1)),
            })
          ).result,
        ),
      ).toBe('unexpected_message');
      expect(
        alertOf(
          (
            await runScriptedTls12({
              fixture,
              prematureRecordBeforeShd: sealPlain('application_data', Uint8Array.of(1, 2, 3)),
            })
          ).result,
        ),
      ).toBe('unexpected_message');
      expect(
        alertOf(
          (
            await runScriptedTls12({
              fixture,
              trailingBytesAfterShd: Uint8Array.of(0x0e, 0x00),
            })
          ).result,
        ),
      ).toBe('unexpected_message');
      expect(
        alertOf((await runScriptedTls12({ fixture, malformedServerCcs: Uint8Array.of(2) })).result),
      ).toBe('decode_error');
      expect(
        alertOf(
          (
            await runScriptedTls12({
              fixture,
              trailingBytesAfterFinished: Uint8Array.of(0x00, 0x00),
            })
          ).result,
        ),
      ).toBe('unexpected_message');

      // Bad server Finished -> decrypt_error, AND the fatal alert goes out ENCRYPTED under TLS 1.2 AEAD at seq 1!
      const badFin = await runScriptedTls12({ fixture, tamperServerFinished: true });
      expect(alertOf(badFin.result)).toBe('decrypt_error');
      expect(badFin.lastClientRecord).toBeDefined();
      expect(badFin.clientKeys).toBeDefined();
      const openedAlert = await openTls12Aead(
        badFin.clientKeys!.clientWriteKey,
        badFin.clientKeys!.clientWriteIv,
        1n,
        badFin.lastClientRecord!,
      );
      expect(openedAlert.ok).toBe(true);
      if (openedAlert.ok) {
        expect(openedAlert.type).toBe('alert');
        expect(decodeAlert(openedAlert.payload)).toEqual({
          ok: true,
          alert: { level: 'fatal', description: 'decrypt_error' },
        });
      }
    });
  });

  describe('TLS 1.3 cross-protocol boundaries under default TLS 1.2..1.3 offers', () => {
    const tls12OnlyExtensions: readonly Extension[] = [
      { kind: 'extended_master_secret' },
      { kind: 'renegotiation_info', renegotiatedConnection: new Uint8Array(0) },
      { kind: 'ec_point_formats', formats: [0] },
    ];

    for (const badExt of tls12OnlyExtensions) {
      it(`rejects ${badExt.kind} echoed in a TLS 1.3 ServerHello with illegal_parameter`, async () => {
        const fixture = await makeFixture();
        const duplex = createMemoryDuplex();
        const clientPromise = startTls({
          transport: duplex.client,
          serverName: SERVER_NAME,
          trustAnchors: fixture.trustAnchors,
          validationTime: Temporal.Now.instant(),
          validator: YOZZ_VALIDATOR,
        });

        const chPlain = openPlain((await duplex.server.read())!);
        if (!chPlain.ok) throw new Error('ch');
        const ch = decodeHandshakeMessage(chPlain.payload);
        if (!ch.ok || ch.value.kind !== 'client_hello') throw new Error('ch');

        const serverShare = await generateKeyShare('x25519');
        const sh: HandshakeMessage = {
          kind: 'server_hello',
          legacyVersion: TLS_VERSION.V1_2,
          random: crypto.getRandomValues(new Uint8Array(32)),
          legacySessionIdEcho: ch.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            {
              kind: 'key_share',
              serverShare: { group: NAMED_GROUPS.x25519, keyExchange: serverShare.publicKey },
            },
            badExt,
          ],
        };
        await duplex.server.write(sealPlain('handshake', encodeHandshakeMessage(sh)));
        expect(alertOf(await clientPromise)).toBe('illegal_parameter');
      });

      it(`rejects ${badExt.kind} echoed in a TLS 1.3 EncryptedExtensions with illegal_parameter`, async () => {
        const fixture = await makeFixture();
        const duplex = createMemoryDuplex();
        const clientPromise = startTls({
          transport: duplex.client,
          serverName: SERVER_NAME,
          trustAnchors: fixture.trustAnchors,
          validationTime: Temporal.Now.instant(),
          validator: YOZZ_VALIDATOR,
        });

        const chPlain = openPlain((await duplex.server.read())!);
        if (!chPlain.ok) throw new Error('ch');
        const chBytes = chPlain.payload;
        const ch = decodeHandshakeMessage(chBytes);
        if (!ch.ok || ch.value.kind !== 'client_hello') throw new Error('ch');
        const clientKeyShare = ch.value.extensions.find(e => e.kind === 'key_share');
        const clientPub =
          clientKeyShare?.kind === 'key_share'
            ? clientKeyShare.clientShares?.[0]?.keyExchange
            : undefined;
        if (clientPub === undefined) throw new Error('no client share');

        const serverShare = await generateKeyShare('x25519');
        const shBytes = encodeHandshakeMessage({
          kind: 'server_hello',
          legacyVersion: TLS_VERSION.V1_2,
          random: crypto.getRandomValues(new Uint8Array(32)),
          legacySessionIdEcho: ch.value.legacySessionId,
          cipherSuite: 0x1301,
          legacyCompressionMethod: 0,
          extensions: [
            { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
            {
              kind: 'key_share',
              serverShare: { group: NAMED_GROUPS.x25519, keyExchange: serverShare.publicKey },
            },
          ],
        });

        const shared = await deriveSharedSecret('x25519', serverShare.privateKey, clientPub);
        const hs = await handshakeSecret(
          'TLS_AES_128_GCM_SHA256',
          await earlySecret('TLS_AES_128_GCM_SHA256'),
          shared,
        );
        const sHs = await deriveSecret(
          'TLS_AES_128_GCM_SHA256',
          hs,
          's hs traffic',
          chBytes,
          shBytes,
        );
        const serverKeys = await trafficKeys('TLS_AES_128_GCM_SHA256', sHs);

        await duplex.server.write(sealPlain('handshake', shBytes));
        await duplex.server.write(
          await sealAead(
            serverKeys.key,
            serverKeys.iv,
            0n,
            'handshake',
            encodeHandshakeMessage({ kind: 'encrypted_extensions', extensions: [badExt] }),
          ),
        );

        expect(alertOf(await clientPromise)).toBe('illegal_parameter');
      });
    }

    it('rejects rsa_pkcs1_sha256 in TLS 1.3 CertificateVerify before path validation even when default 1.2..1.3 offered it', async () => {
      const rsaFixture = await makeFixture(await generateRsaKeyPair());
      let validatorCalled = false;
      const trackingValidator: Validator = {
        name: 'tracking-rejector',
        validatePath: async () => {
          validatorCalled = true;
          return { ok: false, reason: { code: 'no-path-to-trust-anchor' } };
        },
      };

      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: SERVER_NAME,
        trustAnchors: rsaFixture.trustAnchors,
        validationTime: Temporal.Now.instant(),
        validator: trackingValidator,
      });

      const chPlain = openPlain((await duplex.server.read())!);
      if (!chPlain.ok) throw new Error('ch');
      const chBytes = chPlain.payload;
      const ch = decodeHandshakeMessage(chBytes);
      if (!ch.ok || ch.value.kind !== 'client_hello') throw new Error('ch');

      // Confirm rsa_pkcs1_sha256 WAS on the wire in ClientHello (because default minVersion is TLS 1.2).
      const sigAlgs = ch.value.extensions.find(e => e.kind === 'signature_algorithms');
      expect(sigAlgs?.kind === 'signature_algorithms' && sigAlgs.schemes).toContain(
        TLS_1_2_SIGNATURE_SCHEMES.rsa_pkcs1_sha256,
      );

      const clientKeyShare = ch.value.extensions.find(e => e.kind === 'key_share');
      const clientPub =
        clientKeyShare?.kind === 'key_share'
          ? clientKeyShare.clientShares?.[0]?.keyExchange
          : undefined;
      if (clientPub === undefined) throw new Error('no client share');

      const serverShare = await generateKeyShare('x25519');
      const shBytes = encodeHandshakeMessage({
        kind: 'server_hello',
        legacyVersion: TLS_VERSION.V1_2,
        random: crypto.getRandomValues(new Uint8Array(32)),
        legacySessionIdEcho: ch.value.legacySessionId,
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_3], isServerHello: true },
          {
            kind: 'key_share',
            serverShare: { group: NAMED_GROUPS.x25519, keyExchange: serverShare.publicKey },
          },
        ],
      });

      const suite = 'TLS_AES_128_GCM_SHA256';
      const shared = await deriveSharedSecret('x25519', serverShare.privateKey, clientPub);
      const hs = await handshakeSecret(suite, await earlySecret(suite), shared);
      const sHs = await deriveSecret(suite, hs, 's hs traffic', chBytes, shBytes);
      const serverKeys = await trafficKeys(suite, sHs);

      const eeBytes = encodeHandshakeMessage({ kind: 'encrypted_extensions', extensions: [] });
      const certBytes = encodeHandshakeMessage({
        kind: 'certificate',
        certificateRequestContext: new Uint8Array(0),
        certificateList: [{ certData: rsaFixture.leaf.der, extensions: [] }],
      });
      // Sign with rsa_pkcs1_sha256 (0x0401) — valid in TLS 1.2, forbidden in TLS 1.3 CertificateVerify!
      const cvBytes = encodeHandshakeMessage({
        kind: 'certificate_verify',
        scheme: TLS_1_2_SIGNATURE_SCHEMES.rsa_pkcs1_sha256,
        signature: new Uint8Array(256),
      });
      const finKey = await finishedKey(suite, sHs);
      const transcriptHashBytes = new Uint8Array(
        await crypto.subtle.digest(
          CIPHER_SUITES[suite].hash,
          concat(chBytes, shBytes, eeBytes, certBytes, cvBytes),
        ),
      );
      const finBytes = encodeHandshakeMessage({
        kind: 'finished',
        verifyData: await verifyData(suite, finKey, transcriptHashBytes),
      });

      await duplex.server.write(sealPlain('handshake', shBytes));
      await duplex.server.write(
        await sealAead(
          serverKeys.key,
          serverKeys.iv,
          0n,
          'handshake',
          concat(eeBytes, certBytes, cvBytes, finBytes),
        ),
      );

      const result = await clientPromise;
      expect(alertOf(result)).toBe('illegal_parameter');
      expect(validatorCalled).toBe(false);
    });
  });

  describe('TLS 1.2 post-handshake connection behavior', () => {
    it('refuses post-handshake HelloRequest (including fragmented) with encrypted no_renegotiation', async () => {
      const fixture = await makeFixture();
      for (const fragmented of [false, true]) {
        const { result, session } = await runScriptedTls12({ fixture });
        expect(result.ok).toBe(true);
        if (!result.ok || session === undefined) return;

        const hrBytes = encodeTls12HandshakeMessage({ kind: 'hello_request' });
        if (fragmented) {
          await session.serverDuplex.write(
            await sealTls12Aead(
              session.keys.serverWriteKey,
              session.keys.serverWriteIv,
              session.serverWriteSeq,
              'handshake',
              hrBytes.subarray(0, 2),
            ),
          );
          session.serverWriteSeq += 1n;
          await session.serverDuplex.write(
            await sealTls12Aead(
              session.keys.serverWriteKey,
              session.keys.serverWriteIv,
              session.serverWriteSeq,
              'handshake',
              hrBytes.subarray(2),
            ),
          );
          session.serverWriteSeq += 1n;
        } else {
          await session.serverDuplex.write(
            await sealTls12Aead(
              session.keys.serverWriteKey,
              session.keys.serverWriteIv,
              session.serverWriteSeq,
              'handshake',
              hrBytes,
            ),
          );
          session.serverWriteSeq += 1n;
        }

        const readRes = await result.connection.read();
        expect(readRes).toEqual({
          ok: false,
          reason: {
            kind: 'alert-sent',
            alert: { level: 'fatal', description: 'no_renegotiation' },
          },
        });

        const alertRec = await session.reader.readRecord();
        expect(alertRec.ok && alertRec.kind === 'record').toBe(true);
        if (alertRec.ok && alertRec.kind === 'record') {
          const opened = await openTls12Aead(
            session.keys.clientWriteKey,
            session.keys.clientWriteIv,
            session.clientReadSeq,
            alertRec.record,
          );
          expect(opened.ok).toBe(true);
          if (opened.ok) {
            expect(opened.type).toBe('alert');
            expect(decodeAlert(opened.payload)).toEqual({
              ok: true,
              alert: { level: 'fatal', description: 'no_renegotiation' },
            });
          }
        }
      }
    });

    it('rejects post-handshake non-HelloRequest handshake and encrypted ChangeCipherSpec with unexpected_message', async () => {
      const fixture = await makeFixture();
      const first = await runScriptedTls12({ fixture });
      if (!first.result.ok || first.session === undefined) throw new Error('expected ok');
      await first.session.serverDuplex.write(
        await sealTls12Aead(
          first.session.keys.serverWriteKey,
          first.session.keys.serverWriteIv,
          first.session.serverWriteSeq,
          'handshake',
          encodeTls12HandshakeMessage({ kind: 'server_hello_done' }),
        ),
      );
      expect(await first.result.connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });

      const second = await runScriptedTls12({ fixture });
      if (!second.result.ok || second.session === undefined) throw new Error('expected ok');
      await second.session.serverDuplex.write(
        await sealTls12Aead(
          second.session.keys.serverWriteKey,
          second.session.keys.serverWriteIv,
          second.session.serverWriteSeq,
          'change_cipher_spec',
          Uint8Array.of(1),
        ),
      );
      expect(await second.result.connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });

    it('enforces empty-record and user_canceled ceilings and per-direction close_notify', async () => {
      const fixture = await makeFixture();
      const { result, session } = await runScriptedTls12({ fixture });
      if (!result.ok || session === undefined) throw new Error('expected ok');

      // 32 empty records + 4 user_canceled warnings, then real data resets both counters.
      for (let i = 0; i < 32; i += 1) {
        await session.serverDuplex.write(
          await sealTls12Aead(
            session.keys.serverWriteKey,
            session.keys.serverWriteIv,
            session.serverWriteSeq,
            'application_data',
            new Uint8Array(0),
          ),
        );
        session.serverWriteSeq += 1n;
      }
      for (let i = 0; i < 4; i += 1) {
        await session.serverDuplex.write(
          await sealTls12Aead(
            session.keys.serverWriteKey,
            session.keys.serverWriteIv,
            session.serverWriteSeq,
            'alert',
            Uint8Array.of(1, 90),
          ),
        );
        session.serverWriteSeq += 1n;
      }
      const data = new TextEncoder().encode('ok-after-empties');
      await session.serverDuplex.write(
        await sealTls12Aead(
          session.keys.serverWriteKey,
          session.keys.serverWriteIv,
          session.serverWriteSeq,
          'application_data',
          data,
        ),
      );
      session.serverWriteSeq += 1n;
      expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: data });

      // Peer close_notify ends only peer writes; client can still write and close cleanly.
      await session.serverDuplex.write(
        await sealTls12Aead(
          session.keys.serverWriteKey,
          session.keys.serverWriteIv,
          session.serverWriteSeq,
          'alert',
          Uint8Array.of(1, 0),
        ),
      );
      expect(await result.connection.read()).toEqual({ ok: true, kind: 'closed' });
      expect(await result.connection.read()).toEqual({ ok: true, kind: 'closed' });

      const reply = new TextEncoder().encode('still-writing');
      expect(await result.connection.write(reply)).toEqual({ ok: true });
      const writtenRec = await session.reader.readRecord();
      if (!writtenRec.ok || writtenRec.kind !== 'record') throw new Error('expected data record');
      expect(
        await openTls12Aead(
          session.keys.clientWriteKey,
          session.keys.clientWriteIv,
          session.clientReadSeq,
          writtenRec.record,
        ),
      ).toEqual({ ok: true, type: 'application_data', payload: reply });
      session.clientReadSeq += 1n;

      expect(await result.connection.close()).toEqual({ ok: true });
      expect(await result.connection.close()).toEqual({ ok: true });
      expect(await result.connection.write(reply)).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { level: 'warning', description: 'close_notify' } },
      });

      const closeRec = await session.reader.readRecord();
      if (!closeRec.ok || closeRec.kind !== 'record') throw new Error('expected close_notify');
      expect(
        await openTls12Aead(
          session.keys.clientWriteKey,
          session.keys.clientWriteIv,
          session.clientReadSeq,
          closeRec.record,
        ),
      ).toEqual({ ok: true, type: 'alert', payload: Uint8Array.of(1, 0) });

      // 33rd empty record aborts.
      const overflowRun = await runScriptedTls12({ fixture });
      if (!overflowRun.result.ok || overflowRun.session === undefined) {
        throw new Error('expected ok');
      }
      for (let i = 0; i < 33; i += 1) {
        await overflowRun.session.serverDuplex.write(
          await sealTls12Aead(
            overflowRun.session.keys.serverWriteKey,
            overflowRun.session.keys.serverWriteIv,
            overflowRun.session.serverWriteSeq,
            'application_data',
            new Uint8Array(0),
          ),
        );
        overflowRun.session.serverWriteSeq += 1n;
      }
      expect(await overflowRun.result.connection.read()).toMatchObject({
        ok: false,
        reason: { kind: 'alert-sent', alert: { description: 'unexpected_message' } },
      });
    });
  });

  it('protocolVersion narrows HandshakeResult for callers and reports hasExtendedMasterSecret', async () => {
    const fixture = await makeFixture();
    const withEms = await runScriptedTls12({ fixture });
    expect(withEms.result.ok).toBe(true);
    if (!withEms.result.ok) return;
    const version: TlsProtocolVersion = withEms.result.protocolVersion;
    expect(version).toBe('TLS 1.2');
    if (withEms.result.protocolVersion === 'TLS 1.2') {
      expect(withEms.result.hasExtendedMasterSecret).toBe(true);
    }

    const withoutEms = await runScriptedTls12({ fixture, omitExtendedMasterSecret: true });
    expect(withoutEms.result.ok).toBe(true);
    if (withoutEms.result.ok && withoutEms.result.protocolVersion === 'TLS 1.2') {
      expect(withoutEms.result.hasExtendedMasterSecret).toBe(false);
    }
  });

  describe('BoGo-uncovered TLS 1.2 protocol and alert regressions', () => {
    it('rejects an ECDSA leaf certificate whose curve was not offered in supported_groups (RFC 8422 §5.1.1)', async () => {
      const p256Fixture = await makeFixture(await generateEcKeyPair('P-256'));
      const rejected = await runScriptedTls12(
        {
          fixture: p256Fixture,
          suite: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
          group: 'secp384r1',
          scheme: 'ecdsa_secp256r1_sha256',
        },
        { supportedGroups: ['secp384r1'] },
      );
      expect(alertOf(rejected.result)).toBe('illegal_parameter');

      const p384Fixture = await makeFixture(await generateEcKeyPair('P-384'));
      const accepted = await runScriptedTls12(
        {
          fixture: p384Fixture,
          suite: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
          group: 'secp384r1',
          scheme: 'ecdsa_secp384r1_sha384',
        },
        { supportedGroups: ['secp384r1'] },
      );
      expect(accepted.result.ok).toBe(true);
    });

    it('checks expected handshake type before decoding body (unsigned ServerKeyExchange in place of Certificate -> unexpected_message)', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        omitCertificateSendUnsignedSke: true,
      });
      expect(alertOf(result)).toBe('unexpected_message');
    });

    it('tolerates supported_groups echoed in TLS 1.2 ServerHello (BigIP interop)', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        extensions: [
          { kind: 'renegotiation_info', renegotiatedConnection: new Uint8Array(0) },
          { kind: 'supported_groups', groups: [NAMED_GROUPS.x25519, NAMED_GROUPS.secp256r1] },
          { kind: 'ec_point_formats', formats: [0] },
          { kind: 'extended_master_secret' },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it('rejects supported_versions=TLS 1.2 in ServerHello with illegal_parameter (RFC 9846 §4.2.1)', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        extensions: [
          { kind: 'supported_versions', versions: [TLS_VERSION.V1_2], isServerHello: true },
        ],
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });

    it('ignores warning alerts before ServerHello when TLS 1.2 is offered, caps at 4, and refuses them under TLS 1.3-only', async () => {
      const fixture = await makeFixture();
      const sniWarning = sealPlain('alert', Uint8Array.of(1, 112));

      const okRun = await runScriptedTls12({
        fixture,
        preServerHelloRecords: [sniWarning],
      });
      expect(okRun.result.ok).toBe(true);

      const tooManyRun = await runScriptedTls12({
        fixture,
        preServerHelloRecords: Array.from({ length: 5 }, () => sniWarning),
      });
      expect(alertOf(tooManyRun.result)).toBe('unexpected_message');

      const duplex = createMemoryDuplex();
      const tls13OnlyPromise = startTls({
        transport: duplex.client,
        serverName: SERVER_NAME,
        trustAnchors: fixture.trustAnchors,
        validationTime: Temporal.Now.instant(),
        validator: YOZZ_VALIDATOR,
        minVersion: 'TLS 1.3',
      });
      await duplex.server.read();
      await duplex.server.write(sniWarning);
      expect(await tls13OnlyPromise).toEqual({
        ok: false,
        reason: {
          kind: 'alert-received',
          alert: { level: 'warning', description: 'unrecognized_name' },
        },
      });
    });

    it('ignores up to 4 non-close_notify warning alerts post-handshake on TLS 1.2 and aborts on the 5th', async () => {
      const fixture = await makeFixture();
      const { result, session } = await runScriptedTls12({ fixture });
      if (!result.ok || session === undefined) throw new Error('expected ok');

      // 4 warning-level unexpected_message alerts interleaved with empty records succeed, then reset on data.
      for (let i = 0; i < 4; i += 1) {
        await session.serverDuplex.write(
          await sealTls12Aead(
            session.keys.serverWriteKey,
            session.keys.serverWriteIv,
            session.serverWriteSeq,
            'alert',
            Uint8Array.of(1, 10),
          ),
        );
        session.serverWriteSeq += 1n;
        await session.serverDuplex.write(
          await sealTls12Aead(
            session.keys.serverWriteKey,
            session.keys.serverWriteIv,
            session.serverWriteSeq,
            'application_data',
            new Uint8Array(0),
          ),
        );
        session.serverWriteSeq += 1n;
      }
      const data = new TextEncoder().encode('after-warnings');
      await session.serverDuplex.write(
        await sealTls12Aead(
          session.keys.serverWriteKey,
          session.keys.serverWriteIv,
          session.serverWriteSeq,
          'application_data',
          data,
        ),
      );
      session.serverWriteSeq += 1n;
      expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: data });

      // 5 consecutive warning alerts abort with fatal unexpected_message.
      for (let i = 0; i < 5; i += 1) {
        await session.serverDuplex.write(
          await sealTls12Aead(
            session.keys.serverWriteKey,
            session.keys.serverWriteIv,
            session.serverWriteSeq,
            'alert',
            Uint8Array.of(1, 10),
          ),
        );
        session.serverWriteSeq += 1n;
      }
      expect(await result.connection.read()).toMatchObject({
        ok: false,
        reason: {
          kind: 'alert-sent',
          alert: { level: 'fatal', description: 'unexpected_message' },
        },
      });
    });

    it('refuses exportKeyingMaterial on a non-EMS TLS 1.2 connection (RFC 7627 §5.4 / RFC 9266 §4.2)', async () => {
      const fixture = await makeFixture();
      const nonEms = await runScriptedTls12({ fixture, omitExtendedMasterSecret: true });
      expect(nonEms.result.ok).toBe(true);
      if (!nonEms.result.ok) return;
      await expect(
        nonEms.result.connection.exportKeyingMaterial(
          'EXPORTER-Channel-Binding',
          new Uint8Array(0),
          32,
        ),
      ).rejects.toThrow(/Extended Master Secret/);

      const withEms = await runScriptedTls12({ fixture });
      expect(withEms.result.ok).toBe(true);
      if (!withEms.result.ok) return;
      expect(
        (
          await withEms.result.connection.exportKeyingMaterial(
            'EXPORTER-Channel-Binding',
            new Uint8Array(0),
            32,
          )
        ).length,
      ).toBe(32);
    });

    it('makes fatal failures sticky on both read and write after bad_record_mac', async () => {
      const fixture = await makeFixture();
      const { result, session } = await runScriptedTls12({ fixture });
      if (!result.ok || session === undefined) throw new Error('expected ok');

      const badRec = await sealTls12Aead(
        session.keys.serverWriteKey,
        session.keys.serverWriteIv,
        session.serverWriteSeq,
        'application_data',
        new TextEncoder().encode('corrupted'),
      );
      badRec[badRec.length - 1]! ^= 0xff;
      session.serverWriteSeq += 1n;

      const goodRec = await sealTls12Aead(
        session.keys.serverWriteKey,
        session.keys.serverWriteIv,
        session.serverWriteSeq,
        'application_data',
        new TextEncoder().encode('must-not-deliver'),
      );
      session.serverWriteSeq += 1n;

      await session.serverDuplex.write(badRec);
      await session.serverDuplex.write(goodRec);

      const firstRead = await result.connection.read();
      expect(firstRead).toEqual({
        ok: false,
        reason: {
          kind: 'alert-sent',
          alert: { level: 'fatal', description: 'bad_record_mac' },
        },
      });
      // Subsequent read() and write() must stay failed rather than advancing to the next record.
      expect(await result.connection.read()).toEqual(firstRead);
      expect(await result.connection.write(new TextEncoder().encode('must-not-send'))).toEqual(
        firstRead,
      );
    });

    it('rejects empty pre-ServerHello handshake records with unexpected_message', async () => {
      const fixture = await makeFixture();
      const duplex = createMemoryDuplex();
      const clientPromise = startTls({
        transport: duplex.client,
        serverName: SERVER_NAME,
        trustAnchors: fixture.trustAnchors,
        validationTime: Temporal.Now.instant(),
        validator: YOZZ_VALIDATOR,
      });

      await duplex.server.read();
      await duplex.server.write(sealPlain('handshake', new Uint8Array(0)));
      expect(alertOf(await clientPromise)).toBe('unexpected_message');
    });

    it('rejects HRR magic random without supported_versions rather than entering TLS 1.2', async () => {
      const fixture = await makeFixture();
      const { result } = await runScriptedTls12({
        fixture,
        serverRandom: HRR_MAGIC_RANDOM,
      });
      expect(alertOf(result)).toBe('illegal_parameter');
    });
  });
});
