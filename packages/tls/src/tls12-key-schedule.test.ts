/**
 * The TLS 1.2 key schedule against three independent sources: the PRF vectors published on the
 * IETF TLS list, a `node:crypto` HMAC re-statement of RFC 5246 §5, and a real OpenSSL handshake
 * whose master secret comes out of its key log.
 */

import { constants, createHash, createHmac } from 'node:crypto';
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net';
import { createServer as createTlsServer, connect as tlsConnect } from 'node:tls';
import { decodeCertificate, issueCertificate } from '@yozz.app/x509';
import { describe, expect, it } from 'vitest';
import { concat, readUint16, readUint24, writeUint16 } from './bytes.ts';
import { decodeHandshakeMessage, decodeTls12HandshakeMessage } from './handshake-messages.ts';
import { openTls12Aead } from './record.ts';
import {
  isTls12VerifyDataValid,
  tls12ExportKeyingMaterial,
  tls12ExtendedMasterSecret,
  tls12KeyBlock,
  tls12MasterSecret,
  tls12Prf,
  tls12TranscriptHash,
  tls12VerifyData,
} from './tls12-key-schedule.ts';
import { verifyServerKeyExchange } from './verify.ts';
import { TLS_1_2_CIPHER_SUITES, type Tls12CipherSuite } from './wire.ts';

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));
const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

const SHA256_SUITE: Tls12CipherSuite = 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256';
const SHA384_SUITE: Tls12CipherSuite = 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384';

/** RFC 5246 §5 restated over `node:crypto`, so the reference shares no code with the subject. */
const referencePrf = (
  suite: Tls12CipherSuite,
  secret: Uint8Array,
  label: string,
  seed: Uint8Array,
  length: number,
): Uint8Array => {
  const algorithm = TLS_1_2_CIPHER_SUITES[suite].hash === 'SHA-256' ? 'sha256' : 'sha384';
  const hmac = (message: Uint8Array) => createHmac(algorithm, secret).update(message).digest();
  const labelled = Buffer.concat([Buffer.from(label, 'ascii'), seed]);
  const blocks: Buffer[] = [];
  let a: Buffer = labelled;
  while (Buffer.concat(blocks).length < length) {
    a = hmac(a);
    blocks.push(hmac(Buffer.concat([a, labelled])));
  }
  return Uint8Array.from(Buffer.concat(blocks).subarray(0, length));
};

const random32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

describe('tls12Prf', () => {
  it('matches the published P_SHA256 vector (100 octets, four blocks)', async () => {
    expect(
      await tls12Prf(
        SHA256_SUITE,
        hex('9bbe436ba940f017b17652849a71db35'),
        'test label',
        hex('a0ba9f936cda311827a6f796ffd5198c'),
        100,
      ),
    ).toEqual(
      hex(
        'e3f229ba727be17b8d122620557cd453c2aab21d07c3d495329b52d4e61edb5a6b301791e90d35c9c9a46b4e14baf9af0fa022f7077def17abfd3797c0564bab4fbc91666e9def9b97fce34f796789baa48082d122ee42c5a72e5a5110fff70187347b66',
      ),
    );
  });

  it('matches the published P_SHA384 vector (148 octets, four blocks)', async () => {
    expect(
      await tls12Prf(
        SHA384_SUITE,
        hex('b80b733d6ceefcdc71566ea48e5567df'),
        'test label',
        hex('cd665cf6a8447dd6ff8b27555edb7465'),
        148,
      ),
    ).toEqual(
      hex(
        '7b0c18e9ced410ed1804f2cfa34a336a1c14dffb4900bb5fd7942107e81c83cde9ca0faa60be9fe34f82b1233c9146a0e534cb400fed2700884f9dc236f80edd8bfa961144c9e8d792eca722a7b32fc3d416d473ebc2c5fd4abfdad05d9184259b5bf8cd4d90fa0d31e2dec479e4f1a26066f2eea9a69236a3e52655c9e9aee691c8f3a26854308d5eaa3be85e0990703d73e56f',
      ),
    );
  });

  for (const suite of [SHA256_SUITE, SHA384_SUITE]) {
    for (const length of [0, 1, 12, 32, 48, 64, 65, 97, 200]) {
      it(`agrees with node:crypto under ${TLS_1_2_CIPHER_SUITES[suite].hash} for ${length} octets`, async () => {
        const secret = crypto.getRandomValues(new Uint8Array(48));
        const seed = crypto.getRandomValues(new Uint8Array(64));
        const output = await tls12Prf(suite, secret, 'some label', seed, length);
        expect(output.length).toBe(length);
        expect(output).toEqual(referencePrf(suite, secret, 'some label', seed, length));
      });
    }
  }

  it('is a prefix family: a shorter output is the start of a longer one', async () => {
    const secret = random32();
    const seed = random32();
    const long = await tls12Prf(SHA256_SUITE, secret, 'x', seed, 100);
    expect(await tls12Prf(SHA256_SUITE, secret, 'x', seed, 33)).toEqual(long.subarray(0, 33));
  });

  for (const length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`refuses a length of ${length}`, async () => {
      await expect(tls12Prf(SHA256_SUITE, random32(), 'x', random32(), length)).rejects.toThrow();
    });
  }
});

describe('tls12TranscriptHash', () => {
  it('hashes the concatenation under the suite hash', async () => {
    const a = ascii('client hello');
    const b = ascii('server hello');
    expect(await tls12TranscriptHash(SHA256_SUITE, a, b)).toEqual(
      Uint8Array.from(createHash('sha256').update(concat(a, b)).digest()),
    );
    expect(await tls12TranscriptHash(SHA384_SUITE, a, b)).toEqual(
      Uint8Array.from(createHash('sha384').update(concat(a, b)).digest()),
    );
  });
});

describe('master secrets', () => {
  for (const suite of [SHA256_SUITE, SHA384_SUITE]) {
    const { hash } = TLS_1_2_CIPHER_SUITES[suite];

    it(`derives the RFC 5246 master secret from client random || server random (${hash})`, async () => {
      const premaster = random32();
      const clientRandom = random32();
      const serverRandom = random32();
      const master = await tls12MasterSecret(suite, premaster, clientRandom, serverRandom);
      expect(master.length).toBe(48);
      expect(master).toEqual(
        referencePrf(suite, premaster, 'master secret', concat(clientRandom, serverRandom), 48),
      );
      expect(master).not.toEqual(
        referencePrf(suite, premaster, 'master secret', concat(serverRandom, clientRandom), 48),
      );
    });

    it(`derives the RFC 7627 extended master secret from the session hash (${hash})`, async () => {
      const premaster = random32();
      const sessionHash = crypto.getRandomValues(
        new Uint8Array(TLS_1_2_CIPHER_SUITES[suite].hashLength),
      );
      const master = await tls12ExtendedMasterSecret(suite, premaster, sessionHash);
      expect(master.length).toBe(48);
      expect(master).toEqual(
        referencePrf(suite, premaster, 'extended master secret', sessionHash, 48),
      );
    });
  }

  it('the standard and extended master secrets differ for the same premaster', async () => {
    const premaster = random32();
    const clientRandom = random32();
    const serverRandom = random32();
    expect(
      await tls12MasterSecret(SHA256_SUITE, premaster, clientRandom, serverRandom),
    ).not.toEqual(
      await tls12ExtendedMasterSecret(SHA256_SUITE, premaster, concat(clientRandom, serverRandom)),
    );
  });
});

describe('tls12KeyBlock', () => {
  for (const suite of [SHA256_SUITE, SHA384_SUITE]) {
    const { keyLength } = TLS_1_2_CIPHER_SUITES[suite];

    it(`expands server random || client random into ${keyLength}-octet keys and 4-octet IVs`, async () => {
      const master = crypto.getRandomValues(new Uint8Array(48));
      const clientRandom = random32();
      const serverRandom = random32();
      const block = await tls12KeyBlock(suite, master, clientRandom, serverRandom);

      // RFC 5246 §6.3: the server random comes first, the reverse of the master secret.
      const expected = referencePrf(
        suite,
        master,
        'key expansion',
        concat(serverRandom, clientRandom),
        2 * keyLength + 8,
      );
      expect(block.clientWriteKey).toEqual(expected.subarray(0, keyLength));
      expect(block.serverWriteKey).toEqual(expected.subarray(keyLength, 2 * keyLength));
      expect(block.clientWriteIv).toEqual(expected.subarray(2 * keyLength, 2 * keyLength + 4));
      expect(block.serverWriteIv).toEqual(expected.subarray(2 * keyLength + 4));
      expect(block.serverWriteIv.length).toBe(4);

      const swapped = referencePrf(
        suite,
        master,
        'key expansion',
        concat(clientRandom, serverRandom),
        keyLength,
      );
      expect(block.clientWriteKey).not.toEqual(swapped);
    });
  }
});

describe('Finished verify_data', () => {
  for (const suite of [SHA256_SUITE, SHA384_SUITE]) {
    const { hash, hashLength } = TLS_1_2_CIPHER_SUITES[suite];
    const master = crypto.getRandomValues(new Uint8Array(48));
    const handshakeHash = crypto.getRandomValues(new Uint8Array(hashLength));

    it(`derives 12 octets per role (${hash})`, async () => {
      const client = await tls12VerifyData(suite, master, 'client', handshakeHash);
      const server = await tls12VerifyData(suite, master, 'server', handshakeHash);
      expect(client).toEqual(referencePrf(suite, master, 'client finished', handshakeHash, 12));
      expect(server).toEqual(referencePrf(suite, master, 'server finished', handshakeHash, 12));
      expect(client).not.toEqual(server);
    });

    it(`accepts the right verify_data and refuses a tampered, swapped or mis-sized one (${hash})`, async () => {
      const server = await tls12VerifyData(suite, master, 'server', handshakeHash);
      expect(await isTls12VerifyDataValid(suite, master, 'server', handshakeHash, server)).toBe(
        true,
      );

      for (const index of [0, 6, 11]) {
        const tampered = new Uint8Array(server);
        tampered[index]! ^= 0x80;
        expect(await isTls12VerifyDataValid(suite, master, 'server', handshakeHash, tampered)).toBe(
          false,
        );
      }
      expect(await isTls12VerifyDataValid(suite, master, 'client', handshakeHash, server)).toBe(
        false,
      );
      expect(
        await isTls12VerifyDataValid(
          suite,
          master,
          'server',
          handshakeHash,
          server.subarray(0, 11),
        ),
      ).toBe(false);
      expect(
        await isTls12VerifyDataValid(
          suite,
          master,
          'server',
          handshakeHash,
          concat(server, Uint8Array.of(0)),
        ),
      ).toBe(false);
      expect(
        await isTls12VerifyDataValid(suite, master, 'server', handshakeHash, new Uint8Array(0)),
      ).toBe(false);
    });
  }
});

describe('tls12ExportKeyingMaterial (RFC 5705 §4)', () => {
  const master = crypto.getRandomValues(new Uint8Array(48));
  const clientRandom = random32();
  const serverRandom = random32();

  it('seeds a null context with the randoms alone', async () => {
    expect(
      await tls12ExportKeyingMaterial(
        SHA256_SUITE,
        master,
        clientRandom,
        serverRandom,
        'EXPORTER-test',
        null,
        40,
      ),
    ).toEqual(
      referencePrf(SHA256_SUITE, master, 'EXPORTER-test', concat(clientRandom, serverRandom), 40),
    );
  });

  it('appends a zero length for an empty context, which is not the null exporter', async () => {
    const empty = await tls12ExportKeyingMaterial(
      SHA384_SUITE,
      master,
      clientRandom,
      serverRandom,
      'EXPORTER-test',
      new Uint8Array(0),
      40,
    );
    expect(empty).toEqual(
      referencePrf(
        SHA384_SUITE,
        master,
        'EXPORTER-test',
        concat(clientRandom, serverRandom, Uint8Array.of(0, 0)),
        40,
      ),
    );
    expect(empty).not.toEqual(
      await tls12ExportKeyingMaterial(
        SHA384_SUITE,
        master,
        clientRandom,
        serverRandom,
        'EXPORTER-test',
        null,
        40,
      ),
    );
  });

  it('appends a uint16 length and the context bytes', async () => {
    const context = crypto.getRandomValues(new Uint8Array(300));
    expect(
      await tls12ExportKeyingMaterial(
        SHA256_SUITE,
        master,
        clientRandom,
        serverRandom,
        'EXPORTER-test',
        context,
        100,
      ),
    ).toEqual(
      referencePrf(
        SHA256_SUITE,
        master,
        'EXPORTER-test',
        concat(clientRandom, serverRandom, writeUint16(300), context),
        100,
      ),
    );
  });
});

type TlsRecord = { readonly type: number; readonly raw: Uint8Array; readonly body: Uint8Array };

const splitRecords = (stream: Uint8Array): readonly TlsRecord[] => {
  const records: TlsRecord[] = [];
  let offset = 0;
  while (offset < stream.length) {
    const length = readUint16(stream, offset + 3);
    const raw = stream.subarray(offset, offset + 5 + length);
    records.push({ type: stream[offset]!, raw, body: raw.subarray(5) });
    offset += 5 + length;
  }
  return records;
};

/** The plaintext handshake messages before ChangeCipherSpec, then the first protected record. */
const splitFlight = (
  stream: Uint8Array,
): { readonly messages: readonly Uint8Array[]; readonly finishedRecord: Uint8Array } => {
  const records = splitRecords(stream);
  const ccs = records.findIndex(record => record.type === 0x14);
  const plaintext = concat(...records.slice(0, ccs).map(record => record.body));
  const messages: Uint8Array[] = [];
  let offset = 0;
  while (offset < plaintext.length) {
    const length = readUint24(plaintext, offset + 1);
    messages.push(plaintext.subarray(offset, offset + 4 + length));
    offset += 4 + length;
  }
  const finished = records[ccs + 1];
  if (finished === undefined) throw new Error('no record after ChangeCipherSpec');
  return { messages, finishedRecord: finished.raw };
};

const pem = (label: string, der: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;

type OpenSslHandshake = {
  readonly clientToServer: Uint8Array;
  readonly serverToClient: Uint8Array;
  readonly keylogClientRandom: Uint8Array;
  readonly masterSecret: Uint8Array;
  readonly clientFinished: Uint8Array;
  readonly serverFinished: Uint8Array;
  readonly exportKeyingMaterial: (
    length: number,
    label: string,
    context?: Uint8Array,
  ) => Uint8Array;
};

/** A real TLS 1.2 handshake between two OpenSSL endpoints, with a proxy recording both directions. */
const openSslHandshake = async ({
  cipher,
  keyPair,
  sigalgs,
  run,
}: {
  readonly cipher: string;
  readonly keyPair?: CryptoKeyPair;
  readonly sigalgs?: string;
  readonly run: (handshake: OpenSslHandshake) => Promise<void>;
}): Promise<void> => {
  const root = await issueCertificate({ commonName: 'tls12 root', isCa: true });
  const leaf = await issueCertificate({
    commonName: 'localhost',
    issuer: root,
    dnsNames: ['localhost'],
    keyPair,
  });
  const server = createTlsServer({
    key: pem(
      'PRIVATE KEY',
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', leaf.keyPair.privateKey)),
    ),
    cert: pem('CERTIFICATE', leaf.der),
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: cipher,
  });
  server.on('secureConnection', socket => socket.on('error', () => {}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const serverAddress = server.address();
  if (serverAddress === null || typeof serverAddress === 'string') throw new Error('no port');

  const clientToServer: Uint8Array[] = [];
  const serverToClient: Uint8Array[] = [];
  const proxySockets: Socket[] = [];
  const proxy = createNetServer(downstream => {
    const upstream = netConnect(serverAddress.port, '127.0.0.1');
    proxySockets.push(downstream, upstream);
    downstream.on('data', chunk => {
      clientToServer.push(Uint8Array.from(chunk));
      upstream.write(chunk);
    });
    upstream.on('data', chunk => {
      serverToClient.push(Uint8Array.from(chunk));
      downstream.write(chunk);
    });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyAddress = proxy.address();
  if (proxyAddress === null || typeof proxyAddress === 'string') throw new Error('no port');

  const keylog: string[] = [];
  const client = tlsConnect({
    host: '127.0.0.1',
    port: proxyAddress.port,
    servername: 'localhost',
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    ciphers: cipher,
    // Like our client: no session_ticket offered, so no NewSessionTicket before the server's Finished.
    secureOptions: constants.SSL_OP_NO_TICKET,
    ...(sigalgs === undefined ? {} : { sigalgs }),
  });
  client.on('keylog', line => keylog.push(line.toString('ascii')));
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('secureConnect', resolve);
      client.once('error', reject);
    });
    const entry = keylog
      .flatMap(line => line.trim().split('\n'))
      .find(line => line.startsWith('CLIENT_RANDOM '));
    if (entry === undefined) throw new Error('OpenSSL logged no CLIENT_RANDOM line');
    const [, clientRandomHex, masterHex] = entry.split(' ');
    // @types/node marks `context` required; Node takes it as optional, which is RFC 5705's no-context exporter.
    const exportWithoutContext = client.exportKeyingMaterial as (
      length: number,
      label: string,
    ) => Buffer;
    const clientFinished = client.getFinished();
    const serverFinished = client.getPeerFinished();
    if (clientRandomHex === undefined || masterHex === undefined) throw new Error('bad keylog');
    if (clientFinished === undefined || serverFinished === undefined) {
      throw new Error('no Finished');
    }

    await run({
      clientToServer: concat(...clientToServer),
      serverToClient: concat(...serverToClient),
      keylogClientRandom: hex(clientRandomHex),
      masterSecret: hex(masterHex),
      clientFinished: Uint8Array.from(clientFinished),
      serverFinished: Uint8Array.from(serverFinished),
      exportKeyingMaterial: (length, label, context) =>
        Uint8Array.from(
          context === undefined
            ? exportWithoutContext.call(client, length, label)
            : client.exportKeyingMaterial(length, label, Buffer.from(context)),
        ),
    });
  } finally {
    client.destroy();
    for (const socket of proxySockets) socket.destroy();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

const finishedMessage = (verifyData: Uint8Array): Uint8Array =>
  concat(Uint8Array.of(20, 0, 0, verifyData.length), verifyData);

const rsaPkcs1KeyPair = (): Promise<CryptoKeyPair> =>
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

/**
 * Everything a TLS 1.2 client derives, checked against what OpenSSL sent and derived: the
 * transcript, both Finished messages, the key block (by opening both protected Finished records),
 * the exporter, and the ServerKeyExchange signature.
 */
describe('against a real OpenSSL TLS 1.2 handshake', () => {
  const ROWS: readonly {
    readonly suite: Tls12CipherSuite;
    readonly cipher: string;
    readonly keyPair?: () => Promise<CryptoKeyPair>;
    readonly sigalgs?: string;
    readonly scheme: number;
  }[] = [
    {
      suite: 'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
      cipher: 'ECDHE-ECDSA-AES128-GCM-SHA256',
      sigalgs: 'ECDSA+SHA256',
      scheme: 0x0403,
    },
    // A P-256 key signing with SHA-384: TLS 1.2's 0x0503 names a hash, not a curve.
    {
      suite: 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
      cipher: 'ECDHE-ECDSA-AES256-GCM-SHA384',
      sigalgs: 'ECDSA+SHA384',
      scheme: 0x0503,
    },
    {
      suite: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
      cipher: 'ECDHE-RSA-AES128-GCM-SHA256',
      keyPair: rsaPkcs1KeyPair,
      sigalgs: 'RSA+SHA256',
      scheme: 0x0401,
    },
    {
      suite: 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
      cipher: 'ECDHE-RSA-AES256-GCM-SHA384',
      keyPair: rsaPkcs1KeyPair,
      sigalgs: 'rsa_pss_rsae_sha384',
      scheme: 0x0805,
    },
  ];

  for (const row of ROWS) {
    it(`${row.suite} with scheme 0x${row.scheme.toString(16).padStart(4, '0')}`, async () => {
      await openSslHandshake({
        cipher: row.cipher,
        keyPair: row.keyPair === undefined ? undefined : await row.keyPair(),
        sigalgs: row.sigalgs,
        run: async handshake => {
          const clientFlight = splitFlight(handshake.clientToServer);
          const serverFlight = splitFlight(handshake.serverToClient);
          const [clientHello, clientKeyExchange] = clientFlight.messages;
          const [serverHello, certificate, serverKeyExchange, serverHelloDone] =
            serverFlight.messages;
          if (
            clientHello === undefined ||
            clientKeyExchange === undefined ||
            serverHello === undefined ||
            certificate === undefined ||
            serverKeyExchange === undefined ||
            serverHelloDone === undefined
          ) {
            throw new Error('unexpected TLS 1.2 flight shape');
          }

          const ch = decodeHandshakeMessage(clientHello);
          const sh = decodeHandshakeMessage(serverHello);
          if (!ch.ok || ch.value.kind !== 'client_hello') throw new Error('no ClientHello');
          if (!sh.ok || sh.value.kind !== 'server_hello') throw new Error('no ServerHello');
          expect(sh.value.cipherSuite).toBe(TLS_1_2_CIPHER_SUITES[row.suite].code);
          // OpenSSL negotiates RFC 7627 when offered, so the logged master secret is the extended one.
          expect(sh.value.extensions).toContainEqual({ kind: 'extended_master_secret' });
          const clientRandom = ch.value.random;
          const serverRandom = sh.value.random;
          expect(clientRandom).toEqual(handshake.keylogClientRandom);

          // Our TLS 1.2 codecs read OpenSSL's messages.
          const cert = decodeTls12HandshakeMessage(certificate);
          const ske = decodeTls12HandshakeMessage(serverKeyExchange);
          expect(decodeTls12HandshakeMessage(serverHelloDone)).toEqual({
            ok: true,
            value: { kind: 'server_hello_done' },
          });
          expect(decodeTls12HandshakeMessage(clientKeyExchange)).toMatchObject({
            ok: true,
            value: { kind: 'client_key_exchange' },
          });
          if (!cert.ok || cert.value.kind !== 'certificate') throw new Error('no Certificate');
          if (!ske.ok || ske.value.kind !== 'server_key_exchange') throw new Error('no SKE');
          expect(ske.value.scheme).toBe(row.scheme);

          const leaf = cert.value.certificateList[0];
          if (leaf === undefined) throw new Error('empty chain');
          const spkiDer = decodeCertificate(leaf).subjectPublicKeyInfo.der;
          const skeOptions = {
            scheme: ske.value.scheme,
            signature: ske.value.signature,
            spkiDer,
            clientRandom,
            serverRandom,
            serverParams: ske.value.serverParams,
          };
          expect(await verifyServerKeyExchange(skeOptions)).toEqual({ ok: true });
          expect(
            await verifyServerKeyExchange({ ...skeOptions, serverRandom: clientRandom }),
          ).toEqual({ ok: false, description: 'decrypt_error' });

          const master = handshake.masterSecret;
          const throughClientKeyExchange = await tls12TranscriptHash(
            row.suite,
            clientHello,
            serverHello,
            certificate,
            serverKeyExchange,
            serverHelloDone,
            clientKeyExchange,
          );
          expect(
            await tls12VerifyData(row.suite, master, 'client', throughClientKeyExchange),
          ).toEqual(handshake.clientFinished);
          const throughClientFinished = await tls12TranscriptHash(
            row.suite,
            clientHello,
            serverHello,
            certificate,
            serverKeyExchange,
            serverHelloDone,
            clientKeyExchange,
            finishedMessage(handshake.clientFinished),
          );
          expect(
            await isTls12VerifyDataValid(
              row.suite,
              master,
              'server',
              throughClientFinished,
              handshake.serverFinished,
            ),
          ).toBe(true);

          // The key block opens both protected Finished records, each at sequence 0.
          const keys = await tls12KeyBlock(row.suite, master, clientRandom, serverRandom);
          expect(
            await openTls12Aead(
              keys.clientWriteKey,
              keys.clientWriteIv,
              0n,
              clientFlight.finishedRecord,
            ),
          ).toEqual({
            ok: true,
            type: 'handshake',
            payload: finishedMessage(handshake.clientFinished),
          });
          expect(
            await openTls12Aead(
              keys.serverWriteKey,
              keys.serverWriteIv,
              0n,
              serverFlight.finishedRecord,
            ),
          ).toEqual({
            ok: true,
            type: 'handshake',
            payload: finishedMessage(handshake.serverFinished),
          });

          const exporter = (context: Uint8Array | null) =>
            tls12ExportKeyingMaterial(
              row.suite,
              master,
              clientRandom,
              serverRandom,
              'EXPORTER-yozz-test',
              context,
              42,
            );
          expect(await exporter(null)).toEqual(
            handshake.exportKeyingMaterial(42, 'EXPORTER-yozz-test'),
          );
          expect(await exporter(new Uint8Array(0))).toEqual(
            handshake.exportKeyingMaterial(42, 'EXPORTER-yozz-test', new Uint8Array(0)),
          );
          expect(await exporter(ascii('context'))).toEqual(
            handshake.exportKeyingMaterial(42, 'EXPORTER-yozz-test', ascii('context')),
          );
        },
      });
    });
  }

  it('rejects RFC 5705 §6 reserved handshake PRF labels', () => {
    for (const label of [
      'client finished',
      'server finished',
      'master secret',
      'key expansion',
      'extended master secret',
    ]) {
      expect(() =>
        tls12ExportKeyingMaterial(
          'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
          new Uint8Array(48),
          new Uint8Array(32),
          new Uint8Array(32),
          label,
          null,
          32,
        ),
      ).toThrow(/reserved/);
    }
  });
});
