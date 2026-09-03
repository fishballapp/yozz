import 'fake-indexeddb/auto';
import type { StartTlsOptions, TlsFailure, TlsSession } from '@yozz.app/tls';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Trust-on-first-use wiring with the relay and handshake faked. */

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
const { loadPin, peerKey, savePin, saveSession, takeSession } = await import('./peer-store');

const HOST = { host: 'imap.example.net', port: 993 } as const;
const PEER = peerKey(HOST.host, HOST.port);

const completed = (pin: string | null, options: StartTlsOptions) => ({
  ok: true,
  connection: {
    read: async () => ({ ok: true, kind: 'closed' }),
    close: async () => ({ ok: true }),
  },
  isResumed: options.session !== undefined,
  peerPublicKeyPin: pin,
});

const refused = (
  code: 'rejected-by-policy' | 'certificate-expired',
  chain: 'peer-sent' | 'session-stored',
) => ({
  ok: false,
  // `certificate-expired` also names a certificate, which nothing here reads.
  reason: {
    kind: 'certificate',
    reason: { code },
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
  it('first use: validates unpinned, then pins the key the completed handshake proved', async () => {
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed('KEY1', o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(optionsOf(0).validator.name).not.toContain('spki-pin');
    expect(optionsOf(0).session).toBeUndefined();
    expect(await loadPin(PEER)).toBe('KEY1');
  });

  it('a pinned host is checked through pinnedValidator and offered its session once', async () => {
    await savePin(PEER, 'KEY1');
    await saveSession(PEER, session());
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed('KEY1', o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(optionsOf(0).validator.name).toContain('spki-pin');
    expect(optionsOf(0).session?.ticket).toEqual(new Uint8Array([1]));
    expect(await takeSession(PEER)).toBeNull();
  });

  it('a refused pin is pin-mismatch, and the stored pin stays', async () => {
    await savePin(PEER, 'KEY1');
    startTls.mockResolvedValueOnce(refused('rejected-by-policy', 'peer-sent'));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res).toEqual({ ok: false, error: { kind: 'pin-mismatch', peer: PEER } });
    expect(await loadPin(PEER)).toBe('KEY1');
  });

  it('a stale stored chain evicts the session and retries exactly once, without one', async () => {
    await savePin(PEER, 'KEY1');
    await saveSession(PEER, session());
    startTls
      .mockResolvedValueOnce(refused('certificate-expired', 'session-stored'))
      .mockImplementationOnce(async (o: StartTlsOptions) => completed('KEY1', o));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(true);
    expect(startTls).toHaveBeenCalledTimes(2);
    expect(optionsOf(0).session).toBeDefined();
    expect(optionsOf(1).session).toBeUndefined();
  });

  it('a refused peer-sent chain is not retried, even with a session in hand', async () => {
    await savePin(PEER, 'KEY1');
    await saveSession(PEER, session());
    startTls.mockResolvedValueOnce(refused('certificate-expired', 'peer-sent'));
    const res = await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(res.ok).toBe(false);
    expect(startTls).toHaveBeenCalledTimes(1);
  });

  it('a pinned host is never re-pinned from a handshake', async () => {
    await savePin(PEER, 'KEY1');
    // pinnedValidator makes this impossible for real; the guard keeps it so.
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed('KEY2', o));
    await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(await loadPin(PEER)).toBe('KEY1');
  });

  it('an unpinned host is never offered a session, so a forgotten key cannot resume back', async () => {
    await saveSession(PEER, session());
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => completed('KEY2', o));
    await openTlsDuplex(HOST, 993, 'IMAPS');
    expect(optionsOf(0).session).toBeUndefined();
    expect(await loadPin(PEER)).toBe('KEY2');
  });

  it('keeps the tickets a connection hands back', async () => {
    await savePin(PEER, 'KEY1');
    startTls.mockImplementationOnce(async (o: StartTlsOptions) => {
      await o.onSession?.(session());
      return completed('KEY1', o);
    });
    await openTlsDuplex(HOST, 993, 'IMAPS');
    expect((await takeSession(PEER))?.ticket).toEqual(new Uint8Array([1]));
  });
});
