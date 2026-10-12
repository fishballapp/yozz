import 'fake-indexeddb/auto';
import type { TlsSession } from '@yozz.app/tls';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { loadUnlockKeys } from '../vault/unlock-keys';
import { peerKey, saveSession, takeSession } from './session-store';

const session = (ticket: number): TlsSession => ({
  serverName: 'imap.example.net',
  expectedPeerName: { kind: 'dns', value: 'imap.example.net' },
  suite: 'TLS_AES_128_GCM_SHA256',
  ticket: new Uint8Array([ticket]),
  preSharedKey: new Uint8Array(32),
  ticketAgeAdd: 7,
  receivedAt: new Date('2026-08-24T00:00:00Z'),
  lifetimeSeconds: 3600,
  authenticatedAt: new Date('2026-08-24T00:00:00Z'),
  peerSignatureScheme: 'ecdsa_secp256r1_sha256',
  peerCertificateChain: { leafDer: new Uint8Array([0x30]), intermediateDer: [] },
});

describe('session store', () => {
  const peer = peerKey('imap.example.net', 993);

  it('hands a session out exactly once, Dates and bytes intact', async () => {
    const idb = new IDBFactory();
    await saveSession(peer, session(1), idb);
    await saveSession(peer, session(2), idb);
    const taken = await takeSession(peer, idb);
    expect(taken?.ticket).toEqual(new Uint8Array([2]));
    expect(taken?.receivedAt).toBeInstanceOf(Date);
    expect(taken?.peerCertificateChain.leafDer).toEqual(new Uint8Array([0x30]));
    expect(await takeSession(peer, idb)).toBeNull();
  });

  it("keeps a session per host:port, so one port is never offered the other's", async () => {
    const idb = new IDBFactory();
    await saveSession(peer, session(1), idb);
    expect(await takeSession(peerKey('imap.example.net', 465), idb)).toBeNull();
    expect((await takeSession(peer, idb))?.ticket).toEqual(new Uint8Array([1]));
  });

  it('shares the database with the vault stores', async () => {
    const idb = new IDBFactory();
    await saveSession(peer, session(1), idb);
    expect(await loadUnlockKeys('u1', idb)).toBeNull();
    expect((await takeSession(peer, idb))?.ticket).toEqual(new Uint8Array([1]));
  });
});
