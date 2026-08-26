import 'fake-indexeddb/auto';
import type { TlsSession } from '@yozz.app/tls';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { loadUnlockKeys } from '../vault/unlock-keys.ts';
import {
  forgetPin,
  listPins,
  loadPin,
  peerKey,
  savePin,
  saveSession,
  takeSession,
} from './peer-store.ts';

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

describe('peer store', () => {
  const peer = peerKey('imap.example.net', 993);

  it('keeps a pin per host:port until it is forgotten', async () => {
    const idb = new IDBFactory();
    expect(await loadPin(peer, idb)).toBeNull();
    await savePin(peer, 'AAAA', idb);
    await savePin(peerKey('imap.example.net', 465), 'BBBB', idb);
    expect(await loadPin(peer, idb)).toBe('AAAA');
    expect(await listPins(idb)).toEqual([
      { peer: 'imap.example.net:465', pin: 'BBBB' },
      { peer, pin: 'AAAA' },
    ]);
    await forgetPin(peer, idb);
    expect(await loadPin(peer, idb)).toBeNull();
  });

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

  it('forgetting a pin drops the session too, so the next handshake is a full one', async () => {
    const idb = new IDBFactory();
    await savePin(peer, 'AAAA', idb);
    await saveSession(peer, session(1), idb);
    await forgetPin(peer, idb);
    expect(await takeSession(peer, idb)).toBeNull();
  });

  it('shares the database with the vault stores', async () => {
    const idb = new IDBFactory();
    await savePin(peer, 'AAAA', idb);
    expect(await loadUnlockKeys('u1', idb)).toBeNull();
    expect(await loadPin(peer, idb)).toBe('AAAA');
  });
});
