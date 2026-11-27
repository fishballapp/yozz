import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { concat, writeUint16, writeUint24 } from './bytes.ts';
import {
  decodeHandshakeMessage,
  decodeTls12HandshakeMessage,
  type Extension,
  encodeHandshakeMessage,
  encodeProductionClientHello,
  encodeTls12HandshakeMessage,
  type HandshakeMessage,
  paddingFor,
  type Tls12HandshakeMessage,
} from './handshake-messages.ts';
import {
  NAMED_GROUPS,
  SIGNATURE_SCHEMES,
  SUPPORTED_SIGNATURE_SCHEMES,
  SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES,
  TLS_1_2_SIGNATURE_SCHEMES,
  TLS_VERSION,
} from './wire.ts';

type HandshakeMessageStep = {
  readonly traceSection: string;
  readonly traceTitle: string;
  readonly actor: 'client' | 'server';
  readonly title: string;
  readonly fieldLabel: string;
  readonly bytes: Uint8Array;
};

const collectHandshakeMessages = (trace: Rfc8448Trace): readonly HandshakeMessageStep[] => {
  const result: HandshakeMessageStep[] = [];
  for (const step of trace.steps) {
    if (/^construct an? .+ handshake message/.test(step.title)) {
      for (const field of step.fields) {
        result.push({
          traceSection: trace.section,
          traceTitle: trace.title,
          actor: step.actor,
          title: step.title,
          fieldLabel: field.label,
          bytes: field.bytes,
        });
      }
    }
  }
  return result;
};

describe('Stage 3: Handshake message codec', () => {
  const allHandshakeMessages = RFC_8448_TRACES.flatMap(collectHandshakeMessages);

  it('collects all published handshake messages across all 5 traces', () => {
    expect(allHandshakeMessages.length).toBeGreaterThanOrEqual(35);
  });

  for (const msgStep of allHandshakeMessages) {
    const name = `§${msgStep.traceSection} {${msgStep.actor}} ${msgStep.title} (${msgStep.fieldLabel}, ${msgStep.bytes.length} octets)`;

    it(`decode & roundtrip: ${name}`, () => {
      const decoded = decodeHandshakeMessage(msgStep.bytes);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      const encoded = encodeHandshakeMessage(decoded.value);
      expect(encoded).toEqual(msgStep.bytes);
    });
  }

  describe('production ClientHello structural properties', () => {
    it('produces a compliant TLS 1.2..1.3 ClientHello by default', () => {
      const keyShare = new Uint8Array(32);
      keyShare.fill(0x55);

      const encoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey: keyShare,
      });

      const decoded = decodeHandshakeMessage(encoded);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;

      expect(decoded.value.kind).toBe('client_hello');
      if (decoded.value.kind !== 'client_hello') return;

      expect(decoded.value.legacyVersion).toBe(TLS_VERSION.V1_2);
      expect(decoded.value.random.length).toBe(32);
      expect(decoded.value.legacySessionId.length).toBe(32);
      expect(decoded.value.cipherSuites).toEqual([0x1301, 0x1302, 0xc02b, 0xc02f, 0xc02c, 0xc030]);
      expect(decoded.value.legacyCompressionMethods).toEqual(Uint8Array.of(0));

      const sni = decoded.value.extensions.find(e => e.kind === 'server_name');
      expect(sni).toEqual({ kind: 'server_name', serverNames: ['imap.example.com'] });

      const groups = decoded.value.extensions.find(e => e.kind === 'supported_groups');
      expect(groups).toEqual({
        kind: 'supported_groups',
        groups: [NAMED_GROUPS.x25519, NAMED_GROUPS.secp256r1, NAMED_GROUPS.secp384r1],
      });

      const versions = decoded.value.extensions.find(e => e.kind === 'supported_versions');
      expect(versions).toEqual({
        kind: 'supported_versions',
        versions: [TLS_VERSION.V1_3, TLS_VERSION.V1_2],
        isServerHello: false,
      });

      const ks = decoded.value.extensions.find(e => e.kind === 'key_share');
      expect(ks).toEqual({
        kind: 'key_share',
        clientShares: [{ group: NAMED_GROUPS.x25519, keyExchange: keyShare }],
      });

      expect(decoded.value.extensions).toContainEqual({ kind: 'ec_point_formats', formats: [0] });
      expect(decoded.value.extensions).toContainEqual({ kind: 'extended_master_secret' });
      expect(decoded.value.extensions).toContainEqual({
        kind: 'renegotiation_info',
        renegotiatedConnection: new Uint8Array(0),
      });
    });

    it('produces a TLS 1.3-only ClientHello when minVersion is TLS 1.3', () => {
      const keyShare = new Uint8Array(32);
      keyShare.fill(0x55);

      const encoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        minVersion: 'TLS 1.3',
        keySharePublicKey: keyShare,
      });

      const decoded = decodeHandshakeMessage(encoded);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') return;

      expect(decoded.value.legacyVersion).toBe(TLS_VERSION.V1_2);
      expect(decoded.value.legacySessionId.length).toBe(32);
      expect(decoded.value.cipherSuites).toEqual([0x1301, 0x1302]);
      expect(decoded.value.extensions.find(e => e.kind === 'supported_versions')).toEqual({
        kind: 'supported_versions',
        versions: [TLS_VERSION.V1_3],
        isServerHello: false,
      });
      expect(decoded.value.extensions.some(e => e.kind === 'ec_point_formats')).toBe(false);
      expect(decoded.value.extensions.some(e => e.kind === 'extended_master_secret')).toBe(false);
      expect(decoded.value.extensions.some(e => e.kind === 'renegotiation_info')).toBe(false);
    });

    it('offers exactly the groups it was given, in the order it was given them', () => {
      const encoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey: new Uint8Array(97),
        group: 'secp384r1',
        supportedGroups: ['secp384r1', 'secp256r1'],
      });

      const decoded = decodeHandshakeMessage(encoded);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') throw new Error('no ClientHello');

      expect(decoded.value.extensions.find(e => e.kind === 'supported_groups')).toEqual({
        kind: 'supported_groups',
        groups: [NAMED_GROUPS.secp384r1, NAMED_GROUPS.secp256r1],
      });
      // The share sits on `group`, which is not required to be the first offer.
      const ks = decoded.value.extensions.find(e => e.kind === 'key_share');
      expect(ks?.kind === 'key_share' && ks.clientShares?.[0]?.group).toBe(NAMED_GROUPS.secp384r1);
    });

    it('offers exactly the signature schemes it was given, in order', () => {
      const encoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey: new Uint8Array(32),
        signatureSchemes: ['ed25519', 'rsa_pss_rsae_sha512'],
      });

      const decoded = decodeHandshakeMessage(encoded);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') throw new Error('no ClientHello');

      expect(decoded.value.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
        kind: 'signature_algorithms',
        schemes: [SIGNATURE_SCHEMES.ed25519, SIGNATURE_SCHEMES.rsa_pss_rsae_sha512],
      });
    });

    it('offers every implemented scheme for the selected version floor when given none', () => {
      // The default is a security boundary too: a scheme dropped from it is one no server may sign with.
      const defaultEncoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey: new Uint8Array(32),
      });
      const defaultDecoded = decodeHandshakeMessage(defaultEncoded);
      if (!defaultDecoded.ok || defaultDecoded.value.kind !== 'client_hello') {
        throw new Error('no ClientHello');
      }
      expect(defaultDecoded.value.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
        kind: 'signature_algorithms',
        schemes: SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES.map(name => TLS_1_2_SIGNATURE_SCHEMES[name]),
      });

      const tls13OnlyEncoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        minVersion: 'TLS 1.3',
        keySharePublicKey: new Uint8Array(32),
      });
      const tls13OnlyDecoded = decodeHandshakeMessage(tls13OnlyEncoded);
      if (!tls13OnlyDecoded.ok || tls13OnlyDecoded.value.kind !== 'client_hello') {
        throw new Error('no ClientHello');
      }
      expect(
        tls13OnlyDecoded.value.extensions.find(e => e.kind === 'signature_algorithms'),
      ).toEqual({
        kind: 'signature_algorithms',
        schemes: SUPPORTED_SIGNATURE_SCHEMES.map(name => SIGNATURE_SCHEMES[name]),
      });
    });
  });

  describe('codec edge cases', () => {
    it('decodes ServerHello without supported_versions successfully (TLS 1.2 shape)', () => {
      // A TLS 1.2 ServerHello: no supported_versions (43).
      const random = new Uint8Array(32);
      const rawSh12: HandshakeMessage = {
        kind: 'server_hello',
        legacyVersion: 0x0303,
        random,
        legacySessionIdEcho: new Uint8Array(0),
        cipherSuite: 0x1301,
        legacyCompressionMethod: 0,
        extensions: [
          { kind: 'key_share', serverShare: { group: 0x001d, keyExchange: new Uint8Array(32) } },
        ],
      };
      const encoded = encodeHandshakeMessage(rawSh12);
      const decoded = decodeHandshakeMessage(encoded);
      expect(decoded.ok).toBe(true);
      if (decoded.ok && decoded.value.kind === 'server_hello') {
        const suppVersions = decoded.value.extensions.find(e => e.kind === 'supported_versions');
        expect(suppVersions).toBeUndefined();
      }
    });

    it('rejects duplicate extension types with illegal_parameter', () => {
      const ext1 = Uint8Array.of(0x00, 0x00, 0x00, 0x00); // type 0, len 0
      const ext2 = Uint8Array.of(0x00, 0x00, 0x00, 0x00); // type 0, len 0
      const extensionsBlock = Uint8Array.of(0x00, 0x08, ...ext1, ...ext2); // total len 8

      const eeMsg = Uint8Array.of(0x08, 0x00, 0x00, 0x0a, ...extensionsBlock);

      const decoded = decodeHandshakeMessage(eeMsg);
      expect(decoded).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
    });

    it('rejects a short EncryptedExtensions whose extension declares 35 missing bytes', () => {
      // The extensions length claims 8 but the unknown extension declares a 35-byte body; the
      // 35-byte pre-binder slack must not apply outside ClientHello.
      const eeMsg = Uint8Array.of(
        0x08,
        0x00,
        0x00,
        0x0a, // handshake header: encrypted_extensions, length 10
        0x00,
        0x08, // extensions block length 8
        0xff,
        0xfe, // unknown type
        0x00,
        0x23, // declares 35 bytes of body
        0x01,
        0x02,
        0x03,
        0x04, // only 4 body bytes present
      );
      expect(decodeHandshakeMessage(eeMsg)).toEqual({
        ok: false,
        description: 'decode_error',
      });
    });

    it('encodes and decodes KeyUpdate correctly', () => {
      const kuFalse: HandshakeMessage = { kind: 'key_update', requestUpdate: false };
      const encodedFalse = encodeHandshakeMessage(kuFalse);
      expect(encodedFalse).toEqual(Uint8Array.of(0x18, 0x00, 0x00, 0x01, 0x00));
      expect(decodeHandshakeMessage(encodedFalse)).toEqual({ ok: true, value: kuFalse });

      const kuTrue: HandshakeMessage = { kind: 'key_update', requestUpdate: true };
      const encodedTrue = encodeHandshakeMessage(kuTrue);
      expect(encodedTrue).toEqual(Uint8Array.of(0x18, 0x00, 0x00, 0x01, 0x01));
      expect(decodeHandshakeMessage(encodedTrue)).toEqual({ ok: true, value: kuTrue });
    });

    it('encodes and decodes empty Certificate (client declining certificate)', () => {
      // Empty context: 0b 00 00 04 00 00 00 00
      const emptyDeclined: HandshakeMessage = {
        kind: 'certificate',
        certificateRequestContext: new Uint8Array(0),
        certificateList: [],
      };
      const encodedEmpty = encodeHandshakeMessage(emptyDeclined);
      expect(encodedEmpty).toEqual(Uint8Array.of(0x0b, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00));
      expect(decodeHandshakeMessage(encodedEmpty)).toEqual({ ok: true, value: emptyDeclined });

      // Non-empty echoed context
      const context = Uint8Array.of(0xaa, 0xbb);
      const withContext: HandshakeMessage = {
        kind: 'certificate',
        certificateRequestContext: context,
        certificateList: [],
      };
      const encodedContext = encodeHandshakeMessage(withContext);
      expect(encodedContext).toEqual(
        Uint8Array.of(0x0b, 0x00, 0x00, 0x06, 0x02, 0xaa, 0xbb, 0x00, 0x00, 0x00),
      );
      expect(decodeHandshakeMessage(encodedContext)).toEqual({ ok: true, value: withContext });
    });
  });

  describe('malformed extension blocks', () => {
    /**
     * RFC 8448 §4's ClientHello is published without its 35 binder bytes. The slack is gated on
     * the message, the length shape and `pre_shared_key` together; as a general rule it was a
     * fail-open parser.
     */
    it('refuses a server message that declares 35 octets it does not carry', () => {
      const honest = encodeHandshakeMessage({ kind: 'encrypted_extensions', extensions: [] });
      expect(decodeHandshakeMessage(honest).ok).toBe(true);

      // One unknown extension whose body is 35 octets shorter than it claims.
      const body = concat(
        writeUint16(4 + 35), // extensions block length
        writeUint16(0x6666), // an extension type we do not know
        writeUint16(35), // declared data length
        // ...and no data at all.
      );
      const truncated = concat(Uint8Array.of(0x08), writeUint24(body.length), body);
      expect(decodeHandshakeMessage(truncated)).toEqual({
        ok: false,
        description: 'decode_error',
      });
    });

    it("still decodes §4's published pre-binder ClientHello", () => {
      const trace4 = RFC_8448_TRACES.find(trace => trace.section === '4');
      if (trace4 === undefined) throw new Error('no §4');
      const hello = trace4.steps
        .flatMap(step => step.fields)
        .find(field => field.label === 'ClientHello');
      if (hello === undefined) throw new Error('no §4 ClientHello');
      expect(decodeHandshakeMessage(hello.bytes).ok).toBe(true);
    });
  });
});

/**
 * RFC 7685's boundaries without BoGo. Drop the `- 4` and a 508-byte hello becomes 516: out of
 * the range, so no peer notices, and off 512, which the RFC asks for where reachable.
 */
describe('RFC 7685 padding boundaries', () => {
  const TARGET = 512;

  it('pads nothing outside the range', () => {
    expect(paddingFor(0)).toBeNull();
    expect(paddingFor(255)).toBeNull();
    expect(paddingFor(512)).toBeNull();
    expect(paddingFor(1200)).toBeNull();
  });

  it('lands exactly on 512 wherever 512 is reachable', () => {
    for (const length of [256, 300, 400, 507, 508]) {
      const body = paddingFor(length);
      if (body === null) throw new Error(`${length} should have been padded`);
      // +4 is the extension's own type and length fields (§4).
      expect(length + 4 + body).toBe(TARGET);
    }
  });

  /** 509..511 cannot reach 512 (an empty extension already adds 4), so §4's remedy is to overshoot. */
  it('escapes the range when 512 is unreachable', () => {
    for (const length of [509, 510, 511]) {
      const body = paddingFor(length);
      expect(body).toBe(0);
      expect(length + 4).toBeGreaterThan(511);
    }
  });

  it('leaves no input inside the range', () => {
    for (let length = 200; length <= 600; length += 1) {
      const body = paddingFor(length);
      const final = body === null ? length : length + 4 + body;
      expect(final < 256 || final > 511).toBe(true);
    }
  });
});

const message = (type: number, body: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(type), writeUint24(body.length), body);

describe('TLS 1.2 handshake messages', () => {
  const ROUND_TRIPS: readonly Tls12HandshakeMessage[] = [
    { kind: 'hello_request' },
    { kind: 'certificate', certificateList: [] },
    {
      kind: 'certificate',
      certificateList: [Uint8Array.of(0x30, 1, 2), new Uint8Array(70_000).fill(7)],
    },
    {
      kind: 'certificate_request',
      certificateTypes: [1, 64],
      signatureSchemes: [0x0403, 0x0401],
      rawAuthorities: Uint8Array.of(0, 3, 0x30, 1, 0),
    },
    {
      kind: 'certificate_request',
      certificateTypes: [1],
      signatureSchemes: [0x0804],
      rawAuthorities: new Uint8Array(0),
    },
    { kind: 'server_hello_done' },
    { kind: 'client_key_exchange', publicKey: new Uint8Array(65).fill(4) },
    { kind: 'finished', verifyData: new Uint8Array(12).fill(9) },
  ];

  for (const msg of ROUND_TRIPS) {
    it(`round-trips ${msg.kind}`, () => {
      expect(decodeTls12HandshakeMessage(encodeTls12HandshakeMessage(msg))).toEqual({
        ok: true,
        value: msg,
      });
    });
  }

  it('lays out Certificate with no request context and no per-entry extensions', () => {
    expect([
      ...encodeTls12HandshakeMessage({
        kind: 'certificate',
        certificateList: [Uint8Array.of(0xaa), Uint8Array.of(0xbb, 0xcc)],
      }),
    ]).toEqual([11, 0, 0, 12, 0, 0, 9, 0, 0, 1, 0xaa, 0, 0, 2, 0xbb, 0xcc]);
  });

  describe('ServerKeyExchange (RFC 8422 §5.4)', () => {
    const publicKey = new Uint8Array(32).fill(0x11);
    const signature = new Uint8Array(71).fill(0x22);
    const body = concat(
      Uint8Array.of(3),
      writeUint16(NAMED_GROUPS.x25519),
      Uint8Array.of(32),
      publicKey,
      writeUint16(0x0403),
      writeUint16(signature.length),
      signature,
    );

    it('decodes, exposing the exact ServerECDHParams bytes the signature covers', () => {
      const bytes = message(12, body);
      const decoded = decodeTls12HandshakeMessage(bytes);
      expect(decoded).toEqual({
        ok: true,
        value: {
          kind: 'server_key_exchange',
          curveType: 3,
          namedCurve: NAMED_GROUPS.x25519,
          publicKey,
          serverParams: body.subarray(0, 36),
          scheme: 0x0403,
          signature,
        },
      });
      if (!decoded.ok) return;
      expect(encodeTls12HandshakeMessage(decoded.value)).toEqual(bytes);
    });

    it('refuses an explicit curve with illegal_parameter', () => {
      for (const curveType of [1, 2]) {
        const explicit = new Uint8Array(body);
        explicit[0] = curveType;
        expect(decodeTls12HandshakeMessage(message(12, explicit))).toEqual({
          ok: false,
          description: 'illegal_parameter',
        });
      }
    });

    it('refuses an empty point or a length that does not add up with decode_error', () => {
      const emptyPoint = concat(
        Uint8Array.of(3, 0, 0x1d, 0),
        writeUint16(0x0403),
        writeUint16(1),
        Uint8Array.of(0),
      );
      const overlongPoint = new Uint8Array(body);
      overlongPoint[3] = 200;
      for (const malformed of [
        new Uint8Array(0),
        body.subarray(0, 3),
        emptyPoint,
        overlongPoint,
        body.subarray(0, 36),
        body.subarray(0, 39),
        body.subarray(0, -1),
        concat(body, Uint8Array.of(0)),
      ]) {
        expect(decodeTls12HandshakeMessage(message(12, malformed))).toEqual({
          ok: false,
          description: 'decode_error',
        });
      }
    });
  });

  it('refuses a malformed Certificate with decode_error', () => {
    const entry = concat(writeUint24(2), Uint8Array.of(1, 2));
    for (const body of [
      new Uint8Array(0),
      Uint8Array.of(0, 0),
      // A zero-length certificate.
      concat(writeUint24(3), writeUint24(0)),
      // Trailing bytes after the list.
      concat(writeUint24(entry.length), entry, Uint8Array.of(0)),
      // The list claims more than it carries.
      concat(writeUint24(entry.length + 1), entry),
      // An entry overrunning the list.
      concat(writeUint24(4), writeUint24(9), Uint8Array.of(1)),
      // A truncated entry length.
      concat(writeUint24(2), Uint8Array.of(0, 0)),
    ]) {
      expect(decodeTls12HandshakeMessage(message(11, body))).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  it('refuses a malformed CertificateRequest with decode_error', () => {
    const valid = concat(Uint8Array.of(1, 64), writeUint16(2), writeUint16(0x0403), writeUint16(0));
    expect(decodeTls12HandshakeMessage(message(13, valid)).ok).toBe(true);
    for (const body of [
      new Uint8Array(0),
      // No certificate types.
      concat(Uint8Array.of(0), writeUint16(2), writeUint16(0x0403), writeUint16(0)),
      // No signature schemes.
      concat(Uint8Array.of(1, 64), writeUint16(0), writeUint16(0)),
      // An odd scheme list.
      concat(Uint8Array.of(1, 64), writeUint16(3), Uint8Array.of(4, 3, 5), writeUint16(0)),
      // Authorities longer than the body.
      concat(Uint8Array.of(1, 64), writeUint16(2), writeUint16(0x0403), writeUint16(5)),
      // Trailing bytes.
      concat(valid, Uint8Array.of(0)),
      // Types overrunning the body.
      Uint8Array.of(9, 1),
      valid.subarray(0, -1),
    ]) {
      expect(decodeTls12HandshakeMessage(message(13, body))).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  it('refuses a body on HelloRequest or ServerHelloDone with decode_error', () => {
    for (const type of [0, 14]) {
      expect(decodeTls12HandshakeMessage(message(type, Uint8Array.of(0)))).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  it('refuses a malformed ClientKeyExchange with decode_error', () => {
    for (const body of [
      new Uint8Array(0),
      Uint8Array.of(0),
      Uint8Array.of(2, 1),
      Uint8Array.of(1, 1, 1),
    ]) {
      expect(decodeTls12HandshakeMessage(message(16, body))).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  it('refuses a framing whose length disagrees with the bytes with decode_error', () => {
    for (const bytes of [
      Uint8Array.of(14, 0, 0),
      Uint8Array.of(14, 0, 0, 1),
      Uint8Array.of(14, 0, 0, 0, 0),
    ]) {
      expect(decodeTls12HandshakeMessage(bytes)).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  it('reads a message TLS 1.2 does not define here as unexpected_message', () => {
    // ClientHello, ServerHello, NewSessionTicket, EncryptedExtensions, CertificateVerify, KeyUpdate.
    for (const type of [1, 2, 4, 8, 15, 24]) {
      expect(decodeTls12HandshakeMessage(message(type, new Uint8Array(0)))).toEqual({
        ok: false,
        description: 'unexpected_message',
      });
    }
  });
});

const serverHelloWith = (extensionBytes: Uint8Array): Uint8Array =>
  message(
    2,
    concat(
      writeUint16(0x0303),
      new Uint8Array(32).fill(5),
      Uint8Array.of(0),
      writeUint16(0xc02f),
      Uint8Array.of(0),
      writeUint16(extensionBytes.length),
      extensionBytes,
    ),
  );

const extension = (type: number, body: Uint8Array): Uint8Array =>
  concat(writeUint16(type), writeUint16(body.length), body);

describe('TLS 1.2 hello extensions', () => {
  it('decodes ec_point_formats, extended_master_secret and renegotiation_info in a ServerHello', () => {
    const bytes = serverHelloWith(
      concat(
        extension(0xff01, Uint8Array.of(0)),
        extension(11, Uint8Array.of(2, 0, 1)),
        extension(23, new Uint8Array(0)),
      ),
    );
    const decoded = decodeHandshakeMessage(bytes);
    if (!decoded.ok || decoded.value.kind !== 'server_hello') throw new Error('no ServerHello');
    expect(decoded.value.extensions).toEqual([
      { kind: 'renegotiation_info', renegotiatedConnection: new Uint8Array(0) },
      { kind: 'ec_point_formats', formats: [0, 1] },
      { kind: 'extended_master_secret' },
    ]);
    expect(encodeHandshakeMessage(decoded.value)).toEqual(bytes);
  });

  it('refuses a malformed TLS 1.2 extension body in a hello with decode_error', () => {
    for (const ext of [
      extension(11, new Uint8Array(0)),
      extension(11, Uint8Array.of(0)),
      extension(11, Uint8Array.of(2, 0)),
      extension(11, Uint8Array.of(1, 0, 0)),
      extension(23, Uint8Array.of(0)),
      extension(0xff01, new Uint8Array(0)),
      extension(0xff01, Uint8Array.of(2, 0)),
      extension(0xff01, Uint8Array.of(0, 0)),
    ]) {
      expect(decodeHandshakeMessage(serverHelloWith(ext))).toEqual({
        ok: false,
        description: 'decode_error',
      });
    }
  });

  /** RFC 9846 §4.3: a known extension in the wrong message is `illegal_parameter`, decided by the caller. */
  it('leaves them unknown in an EncryptedExtensions, however malformed', () => {
    const body = concat(
      extension(11, new Uint8Array(0)),
      extension(23, Uint8Array.of(1)),
      extension(0xff01, new Uint8Array(0)),
    );
    const decoded = decodeHandshakeMessage(message(8, concat(writeUint16(body.length), body)));
    expect(decoded).toEqual({
      ok: true,
      value: {
        kind: 'encrypted_extensions',
        extensions: [
          { kind: 'unknown', typeCode: 11, data: new Uint8Array(0) },
          { kind: 'unknown', typeCode: 23, data: Uint8Array.of(1) },
          { kind: 'unknown', typeCode: 0xff01, data: new Uint8Array(0) },
        ],
      },
    });
  });
});

describe('production ClientHello version range', () => {
  const keySharePublicKey = new Uint8Array(32).fill(0x55);
  const random = new Uint8Array(32).fill(1);
  const legacySessionId = new Uint8Array(32).fill(2);

  const decodeHello = (bytes: Uint8Array) => {
    const decoded = decodeHandshakeMessage(bytes);
    if (!decoded.ok || decoded.value.kind !== 'client_hello') {
      throw new Error('our own ClientHello does not decode');
    }
    return decoded.value;
  };
  const kinds = (extensions: readonly Extension[]) => extensions.map(e => e.kind);

  it('emits the same bytes for TLS 1.2..1.3 spelled out as for the default', () => {
    const base = { serverName: 'imap.example.com', keySharePublicKey, random, legacySessionId };
    expect(
      encodeProductionClientHello({ ...base, minVersion: 'TLS 1.2', maxVersion: 'TLS 1.3' }),
    ).toEqual(encodeProductionClientHello(base));
  });

  it('offers both versions for TLS 1.2..1.3, with every TLS 1.2 addition before the PSK tail', () => {
    const hello = decodeHello(
      encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey,
        minVersion: 'TLS 1.2',
        cookie: Uint8Array.of(1, 2, 3),
        psk: { identity: new Uint8Array(16), obfuscatedTicketAge: 1, binderLength: 32 },
      }),
    );
    expect(hello.legacyVersion).toBe(TLS_VERSION.V1_2);
    expect(hello.cipherSuites).toEqual([0x1301, 0x1302, 0xc02b, 0xc02f, 0xc02c, 0xc030]);
    expect(hello.extensions.find(e => e.kind === 'supported_versions')).toEqual({
      kind: 'supported_versions',
      versions: [TLS_VERSION.V1_3, TLS_VERSION.V1_2],
      isServerHello: false,
    });
    expect(hello.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
      kind: 'signature_algorithms',
      schemes: SUPPORTED_TLS_1_2_SIGNATURE_SCHEMES.map(name => TLS_1_2_SIGNATURE_SCHEMES[name]),
    });
    expect(hello.extensions).toContainEqual({ kind: 'ec_point_formats', formats: [0] });
    expect(hello.extensions).toContainEqual({ kind: 'extended_master_secret' });
    expect(hello.extensions).toContainEqual({
      kind: 'renegotiation_info',
      renegotiatedConnection: new Uint8Array(0),
    });
    const order = kinds(hello.extensions);
    const modes = order.indexOf('psk_key_exchange_modes');
    for (const kind of [
      'ec_point_formats',
      'extended_master_secret',
      'renegotiation_info',
    ] as const) {
      expect(order.indexOf(kind)).toBeLessThan(modes);
    }
    expect(order).toContain('key_share');
    expect(order).toContain('cookie');
    expect(order.at(-1)).toBe('pre_shared_key');
  });

  it('pads a TLS 1.2..1.3 hello right before pre_shared_key, which stays last', () => {
    const paddedLengths = Array.from({ length: 200 }, (_, index) => index + 1).flatMap(length => {
      const bytes = encodeProductionClientHello({
        serverName: 'a'.repeat(length),
        keySharePublicKey,
        minVersion: 'TLS 1.2',
        psk: { identity: new Uint8Array(16), obfuscatedTicketAge: 1, binderLength: 32 },
      });
      const order = kinds(decodeHello(bytes).extensions);
      expect(order.at(-1)).toBe('pre_shared_key');
      if (!order.includes('padding')) return [];
      expect(order.at(-2)).toBe('padding');
      return [bytes.length];
    });
    expect(paddedLengths.length).toBeGreaterThan(0);
    for (const length of paddedLengths) expect([512, 513]).toContain(length);
  });

  it('offers TLS 1.2 alone without any TLS 1.3 machinery', () => {
    const hello = decodeHello(
      encodeProductionClientHello({
        serverName: 'imap.example.com',
        minVersion: 'TLS 1.2',
        maxVersion: 'TLS 1.2',
        // Ignored: they belong to TLS 1.3.
        cookie: Uint8Array.of(1),
        psk: { identity: new Uint8Array(16), obfuscatedTicketAge: 1, binderLength: 32 },
      }),
    );
    expect(hello.legacyVersion).toBe(TLS_VERSION.V1_2);
    expect(hello.legacySessionId).toEqual(new Uint8Array(0));
    expect(hello.cipherSuites).toEqual([0xc02b, 0xc02f, 0xc02c, 0xc030]);
    expect(kinds(hello.extensions)).toEqual([
      'server_name',
      'supported_groups',
      'ec_point_formats',
      'signature_algorithms',
      'signature_algorithms_cert',
      'extended_master_secret',
      'renegotiation_info',
    ]);
    expect(hello.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
      kind: 'signature_algorithms',
      schemes: [0x0403, 0x0503, 0x0804, 0x0805, 0x0806, 0x0807, 0x0401, 0x0501, 0x0601],
    });
  });

  it('offers exactly the TLS 1.2 schemes it was given', () => {
    const hello = decodeHello(
      encodeProductionClientHello({
        serverName: 'imap.example.com',
        minVersion: 'TLS 1.2',
        maxVersion: 'TLS 1.2',
        signatureSchemes: ['rsa_pkcs1_sha256', 'ecdsa_secp256r1_sha256'],
      }),
    );
    expect(hello.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
      kind: 'signature_algorithms',
      schemes: [0x0401, 0x0403],
    });
  });

  it('pads a TLS 1.2-only hello in the RFC 7685 range', () => {
    const padded = Array.from({ length: 250 }, (_, index) => index + 1).flatMap(length => {
      const bytes = encodeProductionClientHello({
        serverName: 'a'.repeat(length),
        minVersion: 'TLS 1.2',
        maxVersion: 'TLS 1.2',
      });
      expect(bytes.length < 256 || bytes.length >= 512).toBe(true);
      const order = kinds(decodeHello(bytes).extensions);
      return order.includes('padding') ? [order.at(-1)] : [];
    });
    expect(padded.length).toBeGreaterThan(0);
    expect(new Set(padded)).toEqual(new Set(['padding']));
  });

  it('throws on a range whose minimum is above its maximum', () => {
    expect(() =>
      encodeProductionClientHello({
        serverName: 'imap.example.com',
        minVersion: 'TLS 1.3',
        maxVersion: 'TLS 1.2',
      }),
    ).toThrow();
  });

  it('requires a key share whenever TLS 1.3 is offered', () => {
    for (const minVersion of ['TLS 1.2', 'TLS 1.3'] as const) {
      expect(() =>
        // @ts-expect-error A TLS 1.3 offer without a key share is a compile error too.
        encodeProductionClientHello({ serverName: 'imap.example.com', minVersion }),
      ).toThrow('keySharePublicKey');
    }
  });
});
