/**
 * The client against a real TLS 1.3 server across every group and suite it offers. RFC 8448
 * is a SHA-256 / X25519 document, so `TLS_AES_256_GCM_SHA384` and P-384 are proven only here;
 * the P-256 and P-384 rows force a real HelloRetryRequest, and `YOZZ_VALIDATOR` validates a
 * chain issued at test time.
 */

import { connect } from 'node:net';
import { YOZZ_VALIDATOR } from '@yozz.app/x509';
import { describe, expect, it, vi } from 'vitest';
import {
  type CurveName,
  issueLocalLeaf,
  LOCAL_SERVER_NAME,
  type SuiteName,
  startLocalServer,
} from '../harness/local-server.ts';
import { socketTransport } from '../harness/socket-transport.ts';
import { startTls } from './handshake.ts';
import { pinnedValidator } from './pinning.ts';
import type { TlsSession } from './session.ts';

const MATRIX: readonly { readonly suite: SuiteName; readonly curve: CurveName }[] = [
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' },
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'P-256' },
  { suite: 'TLS_AES_128_GCM_SHA256', curve: 'P-384' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'X25519' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'P-256' },
  { suite: 'TLS_AES_256_GCM_SHA384', curve: 'P-384' },
];

const openSocket = (port: number) =>
  new Promise<ReturnType<typeof connect>>((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' }, () => resolve(socket));
    socket.on('error', reject);
  });

/** After ServerHello an alert must travel inside an AEAD record; only a peer that decrypts can tell. */
describe('a fatal alert reaches a real peer', () => {
  it('sends unknown_ca, protected, when it trusts no root', async () => {
    const server = await startLocalServer({
      suite: 'TLS_AES_128_GCM_SHA256',
      curve: 'X25519',
    });
    const socket = await openSocket(server.port);
    const transport = socketTransport(socket);
    const written: Uint8Array[] = [];
    try {
      const result = await startTls({
        transport: {
          read: transport.read,
          write: async bytes => {
            written.push(bytes);
            await transport.write(bytes);
          },
        },
        serverName: LOCAL_SERVER_NAME,
        trustAnchors: { findCandidates: () => [] },
        validationTime: new Date(),
        validator: YOZZ_VALIDATOR,
      });

      expect(result).toMatchObject({
        ok: false,
        // The control for the `session-stored` assertion below: the same failure kind, the other chain.
        reason: { kind: 'certificate', chain: 'peer-sent', alert: { description: 'unknown_ca' } },
      });

      await vi.waitFor(() => expect(server.alertsReceived.length).toBeGreaterThan(0));
      expect(server.alertsReceived.join(' ')).toContain('alert number 48');

      // OpenSSL accepts a cleartext alert here, so what the client wrote is checked: outer type 0x17, never 0x15.
      const last = written.at(-1);
      if (last === undefined) throw new Error('the client wrote nothing');
      expect(last[0]).toBe(0x17);
    } finally {
      socket.destroy();
      await server.stop();
    }
  });
});

describe('a real TLS 1.3 server, every group and suite', () => {
  for (const { suite, curve } of MATRIX) {
    it(`${suite} over ${curve}`, async () => {
      const server = await startLocalServer({ suite, curve });
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator: YOZZ_VALIDATOR,
        });

        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;

        // The echo proves the application keys agree on both sides.
        const sent = new TextEncoder().encode('a1 CAPABILITY\r\n');
        expect(await result.connection.write(sent)).toEqual({ ok: true });
        expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });

        // A write above 2^14 goes out as several records; the echo comes back in the server's pieces.
        const big = new Uint8Array(40_000).map((_, index) => index % 251);
        expect(await result.connection.write(big)).toEqual({ ok: true });
        const echoed: number[] = [];
        while (echoed.length < big.length) {
          const chunk = await result.connection.read();
          expect(chunk).toMatchObject({ ok: true, kind: 'data' });
          if (!chunk.ok || chunk.kind !== 'data') return;
          echoed.push(...chunk.bytes);
        }
        expect(Uint8Array.from(echoed)).toEqual(big);
        expect(await result.connection.close()).toEqual({ ok: true });
      } finally {
        socket.destroy();
        await server.stop();
      }
    });
  }
});

/**
 * A ticket OpenSSL minted, handed back to OpenSSL. Both suites run because the binder is a MAC
 * under the ticket's own hash and every other source of truth here is SHA-256.
 */
describe('resumption against a real TLS 1.3 server', () => {
  for (const suite of ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384'] as const) {
    it(`resumes under ${suite}`, async () => {
      const server = await startLocalServer({ suite, curve: 'X25519' });
      const sessions: TlsSession[] = [];

      const connectOnce = async (session: TlsSession | undefined) => {
        const socket = await openSocket(server.port);
        try {
          const result = await startTls({
            transport: socketTransport(socket),
            serverName: LOCAL_SERVER_NAME,
            trustAnchors: server.trustAnchors,
            validationTime: new Date(),
            validator: YOZZ_VALIDATOR,
            session,
            onSession: next => {
              sessions.push(next);
            },
          });
          expect(result).toMatchObject({ ok: true });
          if (!result.ok) throw new Error('handshake failed');

          // The echo proves the keys derived through the PSK agree.
          const sent = new TextEncoder().encode('a1 CAPABILITY\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
          return result;
        } finally {
          socket.destroy();
        }
      };

      try {
        const first = await connectOnce(undefined);
        expect(first.isResumed).toBe(false);

        // The ticket arrives after the handshake, so `read()` produced this.
        const offered = sessions[0];
        if (offered === undefined) throw new Error('the server issued no ticket');
        expect(offered.suite).toBe(suite);
        expect(offered.serverName).toBe(LOCAL_SERVER_NAME);

        const second = await connectOnce(offered);
        expect(second.isResumed).toBe(true);

        /**
         * A resumed handshake verifies no signature, so the scheme came out of the session; pinned to
         * what the server's key can sign. Nothing here reaches the ticket minted on the resumed
         * connection: OpenSSL issues none there (measured).
         */
        expect(first.peerSignatureScheme).toBe('ecdsa_secp256r1_sha256');
        expect(second.peerSignatureScheme).toBe(first.peerSignatureScheme);
      } finally {
        await server.stop();
      }
    });
  }
});

/**
 * Only `validationTime` moves; `now` stays put, so the ticket is still inside its lifetime and
 * the session is offered. The chain is issued at test time, so the refusal comes from a real
 * expiry.
 */
describe('a resumed handshake re-checks the stored chain', () => {
  const YEAR = 365 * 24 * 3600 * 1000;

  const resumeAfterTheLeafExpires = async (reverifyOnResume: boolean | undefined) => {
    const server = await startLocalServer({ suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' });
    const issuedAt = new Date();
    const sessions: TlsSession[] = [];

    const connectOnce = async (session: TlsSession | undefined, validationTime: Date) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime,
          // Frozen so moving `validationTime` does not age the ticket out.
          now: () => issuedAt,
          validator: YOZZ_VALIDATOR,
          session,
          reverifyOnResume,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          // `isResumed` alone does not prove the keys agree.
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectOnce(undefined, issuedAt);
      expect(first.ok).toBe(true);
      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      // `issueCertificate` gives its leaves a year either side.
      return await connectOnce(offered, new Date(issuedAt.getTime() + 2 * YEAR));
    } finally {
      await server.stop();
    }
  };

  it('refuses the resumption when the stored leaf has expired', async () => {
    expect(await resumeAfterTheLeafExpires(undefined)).toMatchObject({
      ok: false,
      reason: {
        kind: 'certificate',
        reason: { code: 'certificate-expired' },
        alert: { description: 'certificate_expired' },
        // `chain: 'session-stored'` means evict and reconnect; `peer-sent` means the host is refused.
        chain: 'session-stored',
      },
    });
  });

  /** Positive control, and BoringSSL's default (`CertificateVerificationDoesNotFailOnResume`). */
  it('resumes the same expired chain when the re-check is off', async () => {
    // The only configuration that produces a `null` pin: this connection validated no chain.
    expect(await resumeAfterTheLeafExpires(false)).toMatchObject({
      ok: true,
      isResumed: true,
      peerPublicKeyPin: null,
    });
  });

  /** The other arm of the same contract: the default re-check DOES report one. */
  it('reports a pin when the resumption re-checks its chain', async () => {
    const server = await startLocalServer({ suite: 'TLS_AES_128_GCM_SHA256', curve: 'X25519' });
    const sessions: TlsSession[] = [];

    const connectOnce = async (session: TlsSession | undefined) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator: YOZZ_VALIDATOR,
          session,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectOnce(undefined);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      const resumed = await connectOnce(offered);
      expect(resumed).toMatchObject({ ok: true, isResumed: true });
      // The stored leaf is the leaf the first connection authenticated.
      if (resumed.ok) expect(resumed.peerPublicKeyPin).toBe(first.peerPublicKeyPin);
    } finally {
      await server.stop();
    }
  });
});

/**
 * Three servers over one root: the original leaf, a reissue under the same key, and a fresh key.
 * All three chains validate, so the pin is the only thing that can separate them.
 */
describe('trust on first use, pinned to the leaf public key', () => {
  const SUITE = 'TLS_AES_128_GCM_SHA256' as const;
  const CURVE = 'X25519' as const;

  const connect = async (
    server: Awaited<ReturnType<typeof startLocalServer>>,
    pin: string | undefined,
  ) => {
    const socket = await openSocket(server.port);
    try {
      const result = await startTls({
        transport: socketTransport(socket),
        serverName: LOCAL_SERVER_NAME,
        trustAnchors: server.trustAnchors,
        validationTime: new Date(),
        validator:
          pin === undefined ? YOZZ_VALIDATOR : pinnedValidator({ validator: YOZZ_VALIDATOR, pin }),
      });
      if (result.ok) {
        // A pin decision is only meaningful on a connection that then works.
        const sent = new TextEncoder().encode('a1 NOOP\r\n');
        expect(await result.connection.write(sent)).toEqual({ ok: true });
        expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
        expect(await result.connection.close()).toEqual({ ok: true });
      }
      return result;
    } finally {
      socket.destroy();
    }
  };

  /** The pin comes from the result, not the validator; see DECISIONS.md, "The pin is learned after CertificateVerify". */
  it('learns a pin only from a completed handshake', async () => {
    const server = await startLocalServer({ suite: SUITE, curve: CURVE });
    try {
      const result = await connect(server, undefined);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.peerPublicKeyPin).toEqual(expect.any(String));
    } finally {
      await server.stop();
    }
  });

  it('is silent through a reissue that keeps the key', async () => {
    const first = await startLocalServer({ suite: SUITE, curve: CURVE });
    const learned = await connect(first, undefined);
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    const pin = learned.peerPublicKeyPin;
    if (pin === null) throw new Error('a full handshake reported no pin');
    await first.stop();

    // A renewal: serial, validity and signature change, the key does not.
    const renewed = await issueLocalLeaf(first.chain.root, first.chain.leaf.keyPair);
    expect(Buffer.from(renewed.der).equals(Buffer.from(first.chain.leaf.der))).toBe(false);

    const second = await startLocalServer({
      suite: SUITE,
      curve: CURVE,
      chain: { root: first.chain.root, leaf: renewed },
    });
    try {
      const result = await connect(second, pin);
      expect(result).toMatchObject({ ok: true });
      // The pin the caller would store back is the same one.
      if (result.ok) expect(result.peerPublicKeyPin).toBe(pin);
    } finally {
      await second.stop();
    }
  });

  it('refuses a chain that validates under a key it has not seen', async () => {
    const first = await startLocalServer({ suite: SUITE, curve: CURVE });
    const learned = await connect(first, undefined);
    expect(learned.ok).toBe(true);
    if (!learned.ok) return;
    const pin = learned.peerPublicKeyPin;
    if (pin === null) throw new Error('a full handshake reported no pin');
    await first.stop();

    // The rogue-CA shape: a trusted root, a known host, an unknown key.
    const rotated = await issueLocalLeaf(first.chain.root);
    const second = await startLocalServer({
      suite: SUITE,
      curve: CURVE,
      chain: { root: first.chain.root, leaf: rotated },
    });
    try {
      expect(await connect(second, pin)).toMatchObject({
        ok: false,
        reason: {
          kind: 'certificate',
          reason: { code: 'rejected-by-policy' },
          // Not `unknown_ca`: the CA is one we ship and the chain is sound (§6.2).
          alert: { description: 'certificate_unknown' },
          chain: 'peer-sent',
        },
      });

      // Read by something that is not the client.
      await vi.waitFor(() => expect(second.alertsReceived.length).toBeGreaterThan(0));
      expect(second.alertsReceived.join(' ')).toContain('alert number 46');
    } finally {
      await second.stop();
    }
  });

  /** The resumed path reaches the pin through the same `validatePeerChain`. */
  it('checks the stored chain on a resumption too', async () => {
    const server = await startLocalServer({ suite: SUITE, curve: CURVE });
    const sessions: TlsSession[] = [];

    const connectWith = async (session: TlsSession | undefined, pin: string | undefined) => {
      const socket = await openSocket(server.port);
      try {
        const result = await startTls({
          transport: socketTransport(socket),
          serverName: LOCAL_SERVER_NAME,
          trustAnchors: server.trustAnchors,
          validationTime: new Date(),
          validator:
            pin === undefined
              ? YOZZ_VALIDATOR
              : pinnedValidator({ validator: YOZZ_VALIDATOR, pin }),
          session,
          onSession: next => {
            sessions.push(next);
          },
        });
        if (result.ok) {
          // A ticket arrives after the handshake, so `onSession` fires from `read()`.
          const sent = new TextEncoder().encode('a1 NOOP\r\n');
          expect(await result.connection.write(sent)).toEqual({ ok: true });
          expect(await result.connection.read()).toEqual({ ok: true, kind: 'data', bytes: sent });
          expect(await result.connection.close()).toEqual({ ok: true });
        }
        return result;
      } finally {
        socket.destroy();
      }
    };

    try {
      const first = await connectWith(undefined, undefined);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const pin = first.peerPublicKeyPin;
      if (pin === null) throw new Error('a full handshake reported no pin');

      const offered = sessions[0];
      if (offered === undefined) throw new Error('the server issued no ticket');

      // Accepted, and the re-check reports the stored leaf's pin.
      const resumed = await connectWith(offered, pin);
      expect(resumed).toMatchObject({ ok: true, isResumed: true });
      if (resumed.ok) expect(resumed.peerPublicKeyPin).toBe(pin);

      // A pin the stored leaf cannot satisfy; nothing on the wire differs. An unused ticket, because
      // a ticket offered twice is a tracking cookie: OpenSSL issues two on the full handshake.
      const unusedTicket = sessions[1];
      if (unusedTicket === undefined) throw new Error('the full handshake issued only one ticket');
      expect(
        await connectWith(unusedTicket, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
      ).toMatchObject({
        ok: false,
        reason: {
          kind: 'certificate',
          reason: { code: 'rejected-by-policy' },
          alert: { description: 'certificate_unknown' },
          chain: 'session-stored',
        },
      });
    } finally {
      await server.stop();
    }
  });
});
