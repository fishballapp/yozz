/**
 * A real TLS 1.3 server, on a real socket, pinned to one group and one suite.
 *
 * This is the peer RFC 8448 cannot be. The traces are a SHA-256 / X25519
 * document, so `TLS_AES_256_GCM_SHA384` and P-384 — the pair `posteo.de`
 * requires — have no published bytes anywhere and can only be proven against
 * something that actually negotiates them.
 *
 * The chain is issued at test time by `@yozz.app/x509`'s own certificate builder, so
 * the client is validated by **`YOZZ_VALIDATOR` against a real root**, not by a
 * test double. That is the first time the two packages meet end to end.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:tls';
import type { IssuedCertificate, TrustAnchorSource } from '@yozz.app/x509';
import { issueCertificate, SERVER_AUTH } from '@yozz.app/x509';

/** Node takes PEM; the builder emits DER. */
const pem = (label: string, der: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;

export const LOCAL_SERVER_NAME = 'localhost';

/**
 * `ciphers`, NOT `ciphersuites`. Node accepts the latter and silently ignores it
 * for TLS 1.3, so a matrix built on it negotiates whatever the server preferred
 * and reports a green row for a suite it never used.
 */
export type SuiteName = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384';
export type CurveName = 'X25519' | 'P-256' | 'P-384';

/**
 * The root and the leaf the server is presenting. Exposed so a test can issue a
 * SECOND leaf under the same root and stand a second server on it — which is
 * how a reissue is staged, and the only way to tell a renewal apart from a key
 * rotation from the client's side.
 */
export type LocalServerChain = {
  readonly root: IssuedCertificate;
  readonly leaf: IssuedCertificate;
};

export type LocalServer = {
  readonly port: number;
  readonly chain: LocalServerChain;
  readonly trustAnchors: TrustAnchorSource;
  /** Every alert the server received, by description, in arrival order. */
  readonly alertsReceived: readonly string[];
  readonly stop: () => Promise<void>;
};

/** The leaf every one of these servers presents, under whichever root it is given. */
export const issueLocalLeaf = (
  root: IssuedCertificate,
  keyPair?: CryptoKeyPair,
): Promise<IssuedCertificate> =>
  issueCertificate({
    commonName: LOCAL_SERVER_NAME,
    issuer: root,
    dnsNames: [LOCAL_SERVER_NAME],
    extendedKeyUsages: [SERVER_AUTH],
    keyPair,
  });

export const startLocalServer = async ({
  suite,
  curve,
  chain,
}: {
  readonly suite: SuiteName;
  readonly curve: CurveName;
  /** Omitted means a fresh root and leaf, which is what every row but the pin tests wants. */
  readonly chain?: LocalServerChain;
}): Promise<LocalServer> => {
  const root =
    chain?.root ?? (await issueCertificate({ commonName: 'yozz local root', isCa: true }));
  const leaf = chain?.leaf ?? (await issueLocalLeaf(root));

  const alertsReceived: string[] = [];
  const server: Server = createServer({
    key: pem(
      'PRIVATE KEY',
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', leaf.keyPair.privateKey)),
    ),
    cert: pem('CERTIFICATE', leaf.der),
    minVersion: 'TLSv1.3',
    maxVersion: 'TLSv1.3',
    ciphers: suite,
    ecdhCurve: curve,
  });

  // OpenSSL reports a received fatal alert as a connection error naming it, which
  // is how the client's alerts get read by something that is not the client.
  server.on('tlsClientError', error => alertsReceived.push(error.message));
  server.on('secureConnection', socket => {
    socket.on('error', error => alertsReceived.push(error.message));
    socket.on('data', chunk => socket.write(chunk));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    port: (address as AddressInfo).port,
    chain: { root, leaf },
    trustAnchors: {
      // The rig issues its own root; no distrust metadata exists for it.
      findCandidates: () => [
        { id: 'yozz-local-root', certificateDer: root.der, serverDistrustAfter: null },
      ],
    },
    alertsReceived,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};
