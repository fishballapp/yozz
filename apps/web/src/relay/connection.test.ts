import 'fake-indexeddb/auto';
import type { StartTlsOptions, TlsFailure, TlsSession } from '@yozz.app/tls';
import { YOZZ_VALIDATOR } from '@yozz.app/x509';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Chain validation and session resumption wiring, with the relay and handshake faked. */

const startTls = vi.fn();
vi.mock('@yozz.app/tls', async importOriginal => ({
  ...(await importOriginal<typeof import('@yozz.app/tls')>()),
  startTls: (options: StartTlsOptions) => startTls(options),
}));
vi.mock('./anchors', () => ({ trustAnchors: async () => ({ anchors: [] }) }));
vi.mock('./transport', () => ({
  openRelayTransport: async () => ({ read: async () => null, write: async () => {}, close() {} }),
}));

const { openTlsDuplex } = await import('./connection');
const { peerKey, saveSession, takeSession } = await import('./session-store');

const HOST = { host: 'imap.example.net', port: 993 } as const;
const PEER = peerKey(HOST.host, HOST.port);

const completed = (options: StartTlsOptions) => ({
  ok: true,
  connection: {
    read: async () => ({ ok: true, kind: 'closed' }),
    close: async () => ({ ok: true }),
  },
  isResumed: options.session !== undefined,
});

const expired = (chain: 'peer-sent' | 'session-stored') => ({
  ok: false,
  // `certificate-expired` also names a certificate, which nothing here reads.
  reason: {
    kind: 'certificate',
    reason: { code: 'certificate-expired' },
    alert: { level: 'fatal', description: 'certificate_unknown' },
    chain,
  } as unknown as TlsFailure,
});

const session = (): TlsSession => ({
  serverName: HOST.host,
  expectedPeerName: { kind: 'dns', value: HOST.host },
  suite: 'TLS_AES_128_GCM_SHA256',
  ticket: new Uint8Array([1]),
  preSharedKey: new Uint8Array(32),
  ticketAgeAdd: 0,
  receivedAt: new Date(),
  lifetimeSeconds: 3600,
  authenticatedAt: new Date(),
  peerSignatureScheme: 'ecdsa_secp256r1_sha256',
  peerCertificateChain: { leafDer: new Uint8Array([0x30]), intermediateDer: [] },
});

const optionsOf = (call: number): StartTlsOptions => {
  const options = startTls.mock.calls[call]?.[0];
  if (options === undefined) throw new Error(`startTls was not called ${call + 1} times`);
  return options;
};

beforeEach(() => {
  startTls.mockReset();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('openTlsDuplex', () => {
  it('validates the chain alone, and keeps nothing about the key', async () => {
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed(o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(optionsOf(0).validator).toBe(YOZZ_VALIDATOR);
    expect(optionsOf(0).session).toBeUndefined();
  });

  it('offers a stored session once', async () => {
    await saveSession(PEER, session());
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed(o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(optionsOf(0).session?.ticket).toEqual(new Uint8Array([1]));
    expect(await takeSession(PEER)).toBeNull();
  });

  it('a stale stored chain evicts the session and retries exactly once, without one', async () => {
    await saveSession(PEER, session());
    startTls
      .mockResolvedValueOnce(expired('session-stored'))
      .mockImplementationOnce(async (o: StartTlsOptions) => completed(o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(startTls).toHaveBeenCalledTimes(2);
    expect(optionsOf(0).session).toBeDefined();
    expect(optionsOf(1).session).toBeUndefined();
  });

  it('a refused peer-sent chain is not retried, even with a session in hand', async () => {
    await saveSession(PEER, session());
    startTls.mockResolvedValueOnce(expired('peer-sent'));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.kind).toBe('tls');
    expect(startTls).toHaveBeenCalledTimes(1);
  });

  it('keeps the tickets a connection hands back', async () => {
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => {
      await o.onSession?.(session());
      return completed(o);
    });
    await openTlsDuplex(HOST, 993, 'IMAPS');
    expect((await takeSession(PEER))?.ticket).toEqual(new Uint8Array([1]));
  });
});
