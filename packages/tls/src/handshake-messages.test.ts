import { describe, expect, it } from 'vitest';
import { RFC_8448_TRACES, type Rfc8448Trace } from '../vectors/rfc8448.ts';
import { concat, writeUint16, writeUint24 } from './bytes.ts';
import {
  decodeHandshakeMessage,
  encodeHandshakeMessage,
  encodeProductionClientHello,
  type HandshakeMessage,
  paddingFor,
} from './handshake-messages.ts';
import {
  NAMED_GROUPS,
  SIGNATURE_SCHEMES,
  SUPPORTED_SIGNATURE_SCHEMES,
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
    // Check we collected the expected count (at least 35 messages across all traces)
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
    it('produces a compliant TLS 1.3 ClientHello', () => {
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
      expect(decoded.value.cipherSuites).toEqual([0x1301, 0x1302]);
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
        versions: [TLS_VERSION.V1_3],
        isServerHello: false,
      });

      const ks = decoded.value.extensions.find(e => e.kind === 'key_share');
      expect(ks).toEqual({
        kind: 'key_share',
        clientShares: [{ group: NAMED_GROUPS.x25519, keyExchange: keyShare }],
      });
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

    it('offers every implemented scheme when it was given none', () => {
      // The default is the security boundary as much as the explicit list is —
      // a scheme dropped from it is one no server may sign with.
      const encoded = encodeProductionClientHello({
        serverName: 'imap.example.com',
        keySharePublicKey: new Uint8Array(32),
      });

      const decoded = decodeHandshakeMessage(encoded);
      if (!decoded.ok || decoded.value.kind !== 'client_hello') throw new Error('no ClientHello');

      expect(decoded.value.extensions.find(e => e.kind === 'signature_algorithms')).toEqual({
        kind: 'signature_algorithms',
        schemes: SUPPORTED_SIGNATURE_SCHEMES.map(name => SIGNATURE_SCHEMES[name]),
      });
    });
  });

  describe('codec edge cases', () => {
    it('decodes ServerHello without supported_versions successfully (TLS 1.2 shape)', () => {
      // 1.2 ServerHello: version 0x0303, random 32B, sessId 0B, suite 0x1301, comp 0, extensions (no 43)
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
      // Construct extensions block with two server_name extensions
      const ext1 = Uint8Array.of(0x00, 0x00, 0x00, 0x00); // type 0, len 0
      const ext2 = Uint8Array.of(0x00, 0x00, 0x00, 0x00); // type 0, len 0
      const extensionsBlock = Uint8Array.of(0x00, 0x08, ...ext1, ...ext2); // total len 8

      // Wrap in EncryptedExtensions message (type 8, len 10)
      const eeMsg = Uint8Array.of(0x08, 0x00, 0x00, 0x0a, ...extensionsBlock);

      const decoded = decodeHandshakeMessage(eeMsg);
      expect(decoded).toEqual({
        ok: false,
        description: 'illegal_parameter',
      });
    });

    it('rejects a short EncryptedExtensions whose extension declares 35 missing bytes', () => {
      // 10-byte EE: extensions length claims 8, but the unknown extension declares
      // a 35-byte body that is not present. The 35-byte pre-binder slack must not
      // apply outside ClientHello.
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
     * RFC 8448 §4's ClientHello is published without its 35 binder bytes, so the
     * extension parser has to tolerate a block 35 octets shorter than declared.
     * A review found that slack written as a GENERAL rule, which is a fail-open
     * parser — any server message could declare bytes it never sent. It is now
     * gated on the message, the length shape and `pre_shared_key` together.
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
 * RFC 7685's boundaries, in a test that needs neither Go nor a 337MB checkout.
 *
 * BoGo's `ClientHelloPadding` was the only thing pinning this, and a review
 * named what that misses: a mutation that always escapes the 256..511 range
 * without landing on 512 — drop the `- 4` and a 508-byte hello becomes 516 —
 * breaks nothing a peer would notice and fails no vitest. The RFC asks for 512
 * where 512 is reachable, and for escape where it is not.
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
      // +4 is the extension's own type and length fields, which §4 calls out.
      expect(length + 4 + body).toBe(TARGET);
    }
  });

  /**
   * 509..511 cannot reach 512 — an empty padding extension already adds 4 — so
   * §4's remedy is to overshoot, which still leaves the range an F5 terminator
   * hangs on. The zero floor is that case, not a rounding guard.
   */
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
