/**
 * A real TLS 1.3 or TLS 1.2 OpenSSL server pinned to one group and one suite: RFC 8448 covers only
 * SHA-256 and X25519, so `TLS_AES_256_GCM_SHA384`, P-384, and TLS 1.2 interop are proven here.
 * The chain is issued by `@yozz.app/x509`'s builder, so `YOZZ_VALIDATOR` validates against a real root.
 */

import type { AddressInfo } from 'node:net';
import { createServer, type Server, type TLSSocket } from 'node:tls';
import type { IssuedCertificate, TrustAnchorSource } from '@yozz.app/x509';
import { issueCertificate, SERVER_AUTH } from '@yozz.app/x509';

/** Node takes PEM; the builder emits DER. */
const pem = (label: string, der: Uint8Array): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;

export const LOCAL_SERVER_NAME = 'localhost';

/** `ciphers`, not `ciphersuites`: Node silently ignores the latter for TLS 1.3. */
export type Tls13SuiteName = 'TLS_AES_128_GCM_SHA256' | 'TLS_AES_256_GCM_SHA384';

/** OpenSSL cipher names for our four ephemeral ECDHE + AES-GCM TLS 1.2 suites. */
export type Tls12SuiteName =
  | 'ECDHE-ECDSA-AES128-GCM-SHA256'
  | 'ECDHE-RSA-AES128-GCM-SHA256'
  | 'ECDHE-ECDSA-AES256-GCM-SHA384'
  | 'ECDHE-RSA-AES256-GCM-SHA384';

export type SuiteName = Tls13SuiteName | Tls12SuiteName;
export type CurveName = 'X25519' | 'P-256' | 'P-384';
export type NodeTlsVersion = 'TLSv1.2' | 'TLSv1.3';

/** Exposed so a test can issue a second leaf under the same root and stand a second server on it. */
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
  ciphers,
  curve,
  chain,
  keyPair,
  tlsVersion = 'TLSv1.3',
  minVersion,
  maxVersion,
  sigalgs,
  requestCert,
  secureOptions,
  onSecureConnection,
}: {
  readonly suite?: SuiteName;
  /** Overrides `suite` when a test offers both TLS 1.3 and TLS 1.2 suites together. */
  readonly ciphers?: string;
  readonly curve: CurveName;
  /** Omitted means a fresh root and leaf, which is what every row but the pin tests wants. */
  readonly chain?: LocalServerChain;
  /** Optional leaf key pair (e.g. RSA or P-384) used when `chain` is omitted. */
  readonly keyPair?: CryptoKeyPair;
  /** Pinned protocol version when `minVersion`/`maxVersion` are omitted. Defaults to `'TLSv1.3'`. */
  readonly tlsVersion?: NodeTlsVersion;
  readonly minVersion?: NodeTlsVersion;
  readonly maxVersion?: NodeTlsVersion;
  readonly sigalgs?: string;
  readonly requestCert?: boolean;
  readonly secureOptions?: number;
  readonly onSecureConnection?: (socket: TLSSocket) => void;
}): Promise<LocalServer> => {
  const root =
    chain?.root ?? (await issueCertificate({ commonName: 'yozz local root', isCa: true }));
  const leaf = chain?.leaf ?? (await issueLocalLeaf(root, keyPair));

  const alertsReceived: string[] = [];
  const server: Server = createServer({
    key: pem(
      'PRIVATE KEY',
      new Uint8Array(await crypto.subtle.exportKey('pkcs8', leaf.keyPair.privateKey)),
    ),
    cert: pem('CERTIFICATE', leaf.der),
    minVersion: minVersion ?? tlsVersion,
    maxVersion: maxVersion ?? tlsVersion,
    ciphers: ciphers ?? suite,
    ecdhCurve: curve,
    ...(sigalgs === undefined ? {} : { sigalgs }),
    ...(requestCert ? { requestCert: true, rejectUnauthorized: false } : {}),
    ...(secureOptions === undefined ? {} : { secureOptions }),
  });

  // OpenSSL reports a received fatal alert as a connection error naming it.
  server.on('tlsClientError', error => alertsReceived.push(error.message));
  server.on('secureConnection', socket => {
    socket.on('error', error => alertsReceived.push(error.message));
    onSecureConnection?.(socket);
    socket.on('data', chunk => socket.write(chunk));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    port: (address as AddressInfo).port,
    chain: { root, leaf },
    trustAnchors: {
      // The rig issues its own root.
      findCandidates: () => [
        { id: 'yozz-local-root', certificateDer: root.der, serverDistrustAfter: null },
      ],
    },
    alertsReceived,
    stop: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
};
